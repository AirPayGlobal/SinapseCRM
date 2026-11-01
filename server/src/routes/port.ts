import { Router } from 'express';
import { many } from '../db/pool.js';
import { ah, db, qp, staff } from '../lib/http.js';
import { cargoLookup, listNotices, listVesselCalls, sendNotice, upsertVesselCall } from '../services/port.js';

export const portRouter = Router();

portRouter.get('/vessel-calls', staff('port.read', 'query.read'), ah(async (req, res) => res.json(await db(req, (tx) => listVesselCalls(tx, qp(req))))));
portRouter.post('/vessel-calls', staff('port.write'), ah(async (req, res) => res.status(201).json(await db(req, (tx) => upsertVesselCall(tx, req.ctx, req.body ?? {})))));
portRouter.patch('/vessel-calls/:id', staff('port.write'), ah(async (req, res) => res.json(await db(req, (tx) => upsertVesselCall(tx, req.ctx, req.body ?? {}, req.params.id)))));
portRouter.get('/cargo', staff('port.read', 'query.read'), ah(async (req, res) => res.json(await db(req, (tx) => cargoLookup(tx, String(qp(req).q ?? ''))))));
portRouter.get('/corridors', staff('query.read', 'port.read'), ah(async (req, res) => res.json(await db(req, (tx) => many(tx, 'SELECT * FROM corridors ORDER BY name')))));
portRouter.get('/notices', staff('port.read', 'notice.send'), ah(async (req, res) => res.json(await db(req, (tx) => listNotices(tx)))));
portRouter.post('/notices', staff('notice.send'), ah(async (req, res) => res.status(201).json(await db(req, (tx) => sendNotice(tx, req.ctx, req.body ?? {})))));
