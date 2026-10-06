'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { ah, authRequired, requireRole, isNonEmpty, failIfErrors } = require('../middleware');
const { professionalScore } = require('../services/professional-score');
const { auditLog } = require('../services/audit');

const router = express.Router();

const DOC_DIR = path.join(__dirname, '..', '..', 'uploads', 'contractor-docs');
fs.mkdirSync(DOC_DIR, { recursive: true });

const upload = multer({
  dest: DOC_DIR,
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ok = ['application/pdf','image/jpeg','image/png','image/webp'].includes(file.mimetype);
    cb(ok ? null : new Error('Only PDF/JPG/PNG/WEBP documents are allowed.'), ok);
  },
});

async function me(req, res) {
  const c = await db.prepare('SELECT * FROM contractors WHERE user_id = ?').get(req.user.id);
  if (!c) { res.status(404).json({ error: 'Contractor profile not found.' }); return null; }
  return c;
}

function validDate(v) {
  return !v || !isNaN(new Date(v).getTime());
}

router.get('/dashboard', authRequired, requireRole('contractor'), ah(async (req, res) => {
  const c = await me(req,res); if (!c) return;

  const [skills, availability, blackouts, docs, projects, payables, score] = await Promise.all([
    db.prepare('SELECT * FROM contractor_skills WHERE contractor_id = ? ORDER BY is_primary DESC, skill_code').all(c.id),
    db.prepare('SELECT * FROM contractor_availability WHERE contractor_id = ? ORDER BY weekday').all(c.id),
    db.prepare('SELECT * FROM contractor_blackouts WHERE contractor_id = ? ORDER BY start_date').all(c.id),
    db.prepare('SELECT * FROM contractor_documents WHERE contractor_id = ? ORDER BY id DESC').all(c.id),
    db.prepare('SELECT * FROM projects WHERE contractor_id = ? ORDER BY id DESC').all(c.id),
    db.prepare('SELECT * FROM contractor_payables WHERE contractor_id = ? ORDER BY id DESC').all(c.id),
    professionalScore(c.id),
  ]);

  const readinessItems = [
    ['Account active', c.status === 'active'],
    ['License verified', !!c.license_verified],
    ['Insurance verified', !!c.insurance_verified],
    ['Background passed', c.background_check === 'passed'],
    ['At least one skill', skills.length > 0],
    ['Availability configured', availability.some(a => a.is_available)],
  ];

  res.json({
    contractor_id: c.id,
    readiness: {
      percent: Math.round(readinessItems.filter(x=>x[1]).length/readinessItems.length*100),
      items: readinessItems.map(([label,ok])=>({label,ok})),
      ready_for_matching: readinessItems.every(x=>x[1]),
    },
    skills,
    availability,
    blackouts,
    documents: docs,
    professional_score: score,
    jobs: {
      total: projects.length,
      offered: projects.filter(p=>p.contractor_status==='offered').length,
      active: projects.filter(p=>['scheduled','in_progress','review'].includes(p.stage)).length,
      completed: projects.filter(p=>p.stage==='completed').length,
    },
    payouts: {
      pending_cents: payables.filter(x=>x.status==='pending').reduce((a,b)=>a+Number(b.payable_cents||0),0),
      approved_cents: payables.filter(x=>x.status==='approved').reduce((a,b)=>a+Number(b.payable_cents||0),0),
      paid_cents: payables.filter(x=>x.status==='paid').reduce((a,b)=>a+Number(b.payable_cents||0),0),
      items: payables,
    }
  });
}));

router.get('/skills', authRequired, requireRole('contractor'), ah(async (req,res)=>{
  const c=await me(req,res); if(!c)return;
  res.json(await db.prepare('SELECT * FROM contractor_skills WHERE contractor_id=? ORDER BY is_primary DESC,skill_code').all(c.id));
}));

router.put('/skills', authRequired, requireRole('contractor'), ah(async (req,res)=>{
  const c=await me(req,res); if(!c)return;
  const skills=Array.isArray((req.body||{}).skills)?req.body.skills:[];
  if(skills.length>30) return res.status(422).json({error:'Maximum 30 skills.'});

  await db.transaction(async t=>{
    await t.prepare('DELETE FROM contractor_skills WHERE contractor_id=?').run(c.id);
    for(const s of skills){
      const code=String(s.skill_code||'').trim().toLowerCase();
      if(!code || code.length>80) continue;
      const prof=['basic','experienced','expert'].includes(s.proficiency)?s.proficiency:'experienced';
      const years=Math.max(0,Math.min(80,Number(s.years_experience||0)));
      await t.prepare(`INSERT INTO contractor_skills
        (contractor_id,skill_code,proficiency,years_experience,is_primary) VALUES (?,?,?,?,?)`)
        .run(c.id,code,prof,years,s.is_primary?1:0);
    }
  });
  res.json(await db.prepare('SELECT * FROM contractor_skills WHERE contractor_id=? ORDER BY is_primary DESC,skill_code').all(c.id));
}));

router.put('/availability', authRequired, requireRole('contractor'), ah(async (req,res)=>{
  const c=await me(req,res); if(!c)return;
  const rows=Array.isArray((req.body||{}).days)?req.body.days:[];
  await db.transaction(async t=>{
    for(const r of rows){
      const wd=Number(r.weekday);
      if(!Number.isInteger(wd)||wd<0||wd>6) continue;
      const existing=await t.prepare('SELECT id FROM contractor_availability WHERE contractor_id=? AND weekday=?').get(c.id,wd);
      if(existing){
        await t.prepare(`UPDATE contractor_availability SET start_time=?,end_time=?,is_available=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
          .run(r.start_time||null,r.end_time||null,r.is_available===false?0:1,existing.id);
      }else{
        await t.prepare(`INSERT INTO contractor_availability(contractor_id,weekday,start_time,end_time,is_available) VALUES(?,?,?,?,?)`)
          .run(c.id,wd,r.start_time||null,r.end_time||null,r.is_available===false?0:1);
      }
    }
  });
  res.json(await db.prepare('SELECT * FROM contractor_availability WHERE contractor_id=? ORDER BY weekday').all(c.id));
}));

router.post('/blackouts', authRequired, requireRole('contractor'), ah(async (req,res)=>{
  const c=await me(req,res); if(!c)return;
  const b=req.body||{};
  if(!validDate(b.start_date)||!validDate(b.end_date)||!b.start_date||!b.end_date) return res.status(422).json({error:'Valid start/end dates are required.'});
  if(String(b.end_date)<String(b.start_date)) return res.status(422).json({error:'End date cannot be before start date.'});
  const info=await db.prepare(`INSERT INTO contractor_blackouts(contractor_id,start_date,end_date,reason) VALUES(?,?,?,?)`)
    .run(c.id,b.start_date,b.end_date,String(b.reason||'').trim().slice(0,300)||null);
  res.status(201).json(await db.prepare('SELECT * FROM contractor_blackouts WHERE id=?').get(info.lastInsertRowid));
}));

router.delete('/blackouts/:id', authRequired, requireRole('contractor'), ah(async (req,res)=>{
  const c=await me(req,res); if(!c)return;
  await db.prepare('DELETE FROM contractor_blackouts WHERE id=? AND contractor_id=?').run(req.params.id,c.id);
  res.json({deleted:true});
}));

router.get('/documents', authRequired, requireRole('contractor'), ah(async (req,res)=>{
  const c=await me(req,res); if(!c)return;
  res.json(await db.prepare('SELECT * FROM contractor_documents WHERE contractor_id=? ORDER BY id DESC').all(c.id));
}));

router.post('/documents', authRequired, requireRole('contractor'), upload.single('document'), ah(async (req,res)=>{
  const c=await me(req,res); if(!c)return;
  const b=req.body||{};
  const allowed=['license','insurance','workers_comp','w9','business_registration','background_consent','other'];
  if(!allowed.includes(b.doc_type)) return res.status(422).json({error:'Invalid document type.'});
  if(b.expires_on && !validDate(b.expires_on)) return res.status(422).json({error:'Invalid expiration date.'});
  if(!req.file) return res.status(422).json({error:'Document file is required.'});

  const info=await db.prepare(`INSERT INTO contractor_documents
    (contractor_id,doc_type,label,document_number,issuer,expires_on,status,storage_key,original_name,mime)
    VALUES(?,?,?,?,?,?,'submitted',?,?,?)`)
    .run(c.id,b.doc_type,String(b.label||'').trim().slice(0,160)||null,
      String(b.document_number||'').trim().slice(0,160)||null,
      String(b.issuer||'').trim().slice(0,160)||null,
      b.expires_on||null,req.file.filename,req.file.originalname,req.file.mimetype);

  res.status(201).json(await db.prepare('SELECT * FROM contractor_documents WHERE id=?').get(info.lastInsertRowid));
}));

router.get('/payouts', authRequired, requireRole('contractor'), ah(async (req,res)=>{
  const c=await me(req,res); if(!c)return;
  res.json(await db.prepare('SELECT * FROM contractor_payables WHERE contractor_id=? ORDER BY id DESC').all(c.id));
}));

router.post('/projects/:id/daily-log', authRequired, requireRole('contractor'), ah(async (req,res)=>{
  const c=await me(req,res); if(!c)return;
  const p=await db.prepare('SELECT * FROM projects WHERE id=? AND contractor_id=?').get(req.params.id,c.id);
  if(!p) return res.status(404).json({error:'Assigned project not found.'});
  const b=req.body||{};
  if(!isNonEmpty(b.summary,2000)) return res.status(422).json({error:'Daily summary is required.'});
  const hours=b.hours_worked===undefined||b.hours_worked===''?null:Number(b.hours_worked);
  if(hours!==null && (isNaN(hours)||hours<0||hours>24)) return res.status(422).json({error:'Hours must be between 0 and 24.'});

  const info=await db.prepare(`INSERT INTO contractor_daily_logs
    (project_id,contractor_id,work_date,summary,hours_worked,blockers,customer_visible)
    VALUES(?,?,?,?,?,?,?)`)
    .run(p.id,c.id,b.work_date||new Date().toISOString().slice(0,10),b.summary.trim(),hours,
      String(b.blockers||'').trim().slice(0,1500)||null,b.customer_visible?1:0);
  res.status(201).json(await db.prepare('SELECT * FROM contractor_daily_logs WHERE id=?').get(info.lastInsertRowid));
}));

router.get('/projects/:id/daily-logs', authRequired, requireRole('contractor'), ah(async (req,res)=>{
  const c=await me(req,res); if(!c)return;
  const p=await db.prepare('SELECT id FROM projects WHERE id=? AND contractor_id=?').get(req.params.id,c.id);
  if(!p) return res.status(404).json({error:'Assigned project not found.'});
  res.json(await db.prepare('SELECT * FROM contractor_daily_logs WHERE project_id=? AND contractor_id=? ORDER BY work_date DESC,id DESC').all(p.id,c.id));
}));

// Admin document review.
router.patch('/admin/documents/:id', authRequired, requireRole('admin'), ah(async(req,res)=>{
  const d=await db.prepare('SELECT * FROM contractor_documents WHERE id=?').get(req.params.id);
  if(!d) return res.status(404).json({error:'Document not found.'});
  const b=req.body||{};
  if(!['verified','rejected','expired'].includes(b.status)) return res.status(422).json({error:'Invalid review status.'});
  await db.prepare(`UPDATE contractor_documents SET status=?,reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,rejection_reason=? WHERE id=?`)
    .run(b.status,req.user.id,String(b.rejection_reason||'').trim().slice(0,1000)||null,d.id);
  auditLog(req.user.id,'contractor_document.reviewed','contractor_documents',d.id,b.status);
  res.json(await db.prepare('SELECT * FROM contractor_documents WHERE id=?').get(d.id));
}));

module.exports = router;
