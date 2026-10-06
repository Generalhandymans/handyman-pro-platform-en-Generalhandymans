'use strict';

const express=require('express');
const db=require('../db');
const {ah,authRequired,requireRole,isNonEmpty}=require('../middleware');

const router=express.Router();

router.get('/admin/growth',authRequired,requireRole('admin'),ah(async(req,res)=>{
  const bySource=await db.prepare(`
    SELECT COALESCE(source,'direct') source,COUNT(*) leads,
      SUM(CASE WHEN status IN ('assigned','scheduled','in_progress','review','completed') THEN 1 ELSE 0 END) converted
    FROM job_requests GROUP BY COALESCE(source,'direct') ORDER BY leads DESC
  `).all();

  const reviews=await db.prepare(`
    SELECT COUNT(*) total,COALESCE(AVG(rating),0) avg_rating
    FROM reviews
  `).get();

  const referrals=await db.prepare(`
    SELECT COUNT(*) total,
      SUM(CASE WHEN status='redeemed' THEN 1 ELSE 0 END) redeemed
    FROM referrals
  `).get();

  res.json({
    acquisition:bySource.map(x=>({
      source:x.source,
      leads:Number(x.leads||0),
      converted:Number(x.converted||0),
      conversion_pct:Number(x.leads)?Math.round(Number(x.converted||0)/Number(x.leads)*100):0
    })),
    reviews:{total:Number(reviews.total||0),avg_rating:Math.round(Number(reviews.avg_rating||0)*10)/10},
    referrals:{
      total:Number(referrals.total||0),
      redeemed:Number(referrals.redeemed||0),
      redemption_pct:Number(referrals.total)?Math.round(Number(referrals.redeemed||0)/Number(referrals.total)*100):0
    }
  });
}));

router.get('/public/reviews',ah(async(req,res)=>{
  const rows=await db.prepare(`
    SELECT r.rating,r.comment,r.created_at,j.service_type
    FROM reviews r
    JOIN projects p ON p.id=r.project_id
    JOIN job_requests j ON j.id=p.job_request_id
    WHERE r.rating>=4 AND r.comment IS NOT NULL AND LENGTH(TRIM(r.comment))>0
    ORDER BY r.id DESC LIMIT 12
  `).all();
  res.json(rows);
}));

module.exports=router;
