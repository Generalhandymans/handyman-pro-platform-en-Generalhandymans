'use strict';

const express=require('express');
const db=require('../db');
const {ah,authRequired,requireRole}=require('../middleware');
const intel=require('../services/intelligence');
const {auditLog}=require('../services/audit');

const router=express.Router();

async function visibleJob(req,res,id){
  const j=await db.prepare('SELECT * FROM job_requests WHERE id=?').get(id);
  if(!j){res.status(404).json({error:'Job request not found.'});return null;}
  if(req.user.role==='admin') return j;
  if(req.user.role==='customer' && j.customer_id===req.user.id) return j;
  res.status(403).json({error:'Not allowed.'}); return null;
}

router.post('/jobs/:id/build-scope',authRequired,ah(async(req,res)=>{
  const job=await visibleJob(req,res,req.params.id); if(!job)return;
  const scope=JSON.parse(job.scope_json||'{}');
  const photos=await db.prepare('SELECT vision_json FROM photos WHERE job_request_id=? ORDER BY id').all(job.id);
  const vision={observations:[],risks:[],room_hint:null};
  for(const p of photos){
    try{
      const v=JSON.parse(p.vision_json||'{}');
      vision.observations.push(...(v.observations||[]));
      vision.risks.push(...(v.risks||[]));
      if(!vision.room_hint && v.room_hint) vision.room_hint=v.room_hint;
    }catch(_){}
  }

  const result=await intel.buildScope(job,scope,vision);
  const row=await db.prepare('SELECT COALESCE(MAX(version_no),0) AS v FROM job_scope_versions WHERE job_request_id=?').get(job.id);
  await db.prepare(`INSERT INTO job_scope_versions(job_request_id,version_no,source,scope_json,confidence,created_by)
    VALUES(?,?,'ai',?,?,?)`)
    .run(job.id,Number(row.v||0)+1,JSON.stringify(result),result.confidence,req.user.id);

  await db.prepare(`INSERT INTO risk_assessments
    (job_request_id,severity,flags_json,requires_human_review,requires_license_review,requires_permit_review,notes)
    VALUES(?,?,?,?,?,?,?)`)
    .run(job.id,result.risk.severity,JSON.stringify(result.risk.flags),
      result.risk.requires_human_review?1:0,result.risk.requires_license_review?1:0,
      result.risk.requires_permit_review?1:0,
      result.human_review_required?'Review before final quote/dispatch.':null);

  if(req.user.role==='admin') auditLog(req.user.id,'intelligence.scope_built','job_requests',job.id,`confidence=${result.confidence}`);
  res.status(201).json(result);
}));

router.get('/jobs/:id/latest-scope',authRequired,ah(async(req,res)=>{
  const job=await visibleJob(req,res,req.params.id); if(!job)return;
  const row=await db.prepare('SELECT * FROM job_scope_versions WHERE job_request_id=? ORDER BY version_no DESC LIMIT 1').get(job.id);
  if(!row) return res.status(404).json({error:'No structured scope yet.'});
  res.json({...row,scope:JSON.parse(row.scope_json||'{}')});
}));

router.get('/jobs/:id/risk',authRequired,ah(async(req,res)=>{
  const job=await visibleJob(req,res,req.params.id); if(!job)return;
  const row=await db.prepare('SELECT * FROM risk_assessments WHERE job_request_id=? ORDER BY id DESC LIMIT 1').get(job.id);
  if(!row) return res.status(404).json({error:'No risk assessment yet.'});
  res.json({...row,flags:JSON.parse(row.flags_json||'[]')});
}));

router.get('/admin/runs',authRequired,requireRole('admin'),ah(async(req,res)=>{
  const lim=Math.min(200,Math.max(1,Number(req.query.limit||50)));
  res.json(await db.prepare('SELECT * FROM ai_runs ORDER BY id DESC LIMIT ?').all(lim));
}));

router.get('/admin/security-events',authRequired,requireRole('admin'),ah(async(req,res)=>{
  const lim=Math.min(300,Math.max(1,Number(req.query.limit||100)));
  res.json(await db.prepare('SELECT * FROM security_events ORDER BY id DESC LIMIT ?').all(lim));
}));

module.exports=router;
