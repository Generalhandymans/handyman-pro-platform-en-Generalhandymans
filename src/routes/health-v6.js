'use strict';

const express = require('express');
const db = require('../db');
const { readiness } = require('../services/health');

const router = express.Router();

router.get('/live', (req,res)=>{
  res.json({
    ok:true,
    service:'helpman',
    version:process.env.APP_VERSION || null,
    git_sha:process.env.GIT_SHA || null,
    time:new Date().toISOString()
  });
});

router.get('/ready', async (req,res)=>{
  const out=await readiness();
  res.status(out.ok?200:503).json(out);
});

router.get('/metrics-summary', async (req,res)=>{
  try{
    const [jobs,projects,failedPayments] = await Promise.all([
      db.prepare(`SELECT COUNT(*) c FROM job_requests`).get(),
      db.prepare(`SELECT COUNT(*) c FROM projects WHERE stage IN ('assigned','scheduled','in_progress','review')`).get(),
      db.prepare(`SELECT COUNT(*) c FROM payments WHERE status='failed'`).get()
    ]);
    res.json({
      ok:true,
      jobs_total:Number(jobs.c||0),
      active_projects:Number(projects.c||0),
      failed_payments:Number(failedPayments.c||0)
    });
  }catch(e){
    res.status(500).json({ok:false,error:'metrics_unavailable'});
  }
});

module.exports=router;
