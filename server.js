import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import { randomUUID } from 'crypto';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const PORT = process.env.PORT || 3000;
const LOCATION_TTL_MS = Number(process.env.LOCATION_TTL_MS || 120000);
const OFFER_TTL_MS = Number(process.env.OFFER_TTL_MS || 20000);
const MAX_DRIVER_DISTANCE_KM = Number(process.env.MAX_DRIVER_DISTANCE_KM || 10);

app.use(express.json({ limit: '64kb' }));
app.use(express.static('public'));

const locations = new Map();
const connections = new Map();
const rides = new Map();

function json(res, status, payload) { return res.status(status).type('application/json').send(JSON.stringify(payload)); }
function cleanExpired() {
  const now = Date.now();
  for (const [id, loc] of locations) if (loc.expiresAt <= now) locations.delete(id);
  for (const [id, ride] of rides) {
    if (ride.status === 'OFFERING' && ride.offerExpiresAt <= now) {
      const driver = ride.currentDriverId;
      if (driver) sendToDriver(driver, { type: 'RIDE_OFFER_EXPIRED', rideId: id });
      ride.currentDriverId = null;
      ride.status = 'SEARCHING';
      offerNextDriver(ride).catch(console.error);
    }
  }
}
function haversineKm(aLat,aLng,bLat,bLng) {
  const R=6371, rad=Math.PI/180;
  const dLat=(bLat-aLat)*rad, dLng=(bLng-aLng)*rad;
  const x=Math.sin(dLat/2)**2+Math.cos(aLat*rad)*Math.cos(bLat*rad)*Math.sin(dLng/2)**2;
  return 2*R*Math.asin(Math.sqrt(x));
}
function activeDrivers() {
  cleanExpired();
  const now=Date.now();
  return [...locations.values()].filter(x=>x.expiresAt>now && x.status==='AVAILABLE');
}
function sendToDriver(driverId, message) {
  const ws=connections.get(driverId);
  if (!ws || ws.readyState !== 1) return false;
  ws.send(JSON.stringify(message));
  return true;
}
function candidateDrivers(ride) {
  const claimed = new Set([...rides.values()].filter(r=>r.id!==ride.id && ['OFFERING','ACCEPTED','IN_PROGRESS'].includes(r.status)).map(r=>r.currentDriverId).filter(Boolean));
  return activeDrivers().filter(d=>!claimed.has(d.driverId)).map(d=>({...d,distanceKm:haversineKm(ride.pickup.lat,ride.pickup.lng,d.lat,d.lng)})).filter(d=>d.distanceKm<=MAX_DRIVER_DISTANCE_KM).sort((a,b)=>a.distanceKm-b.distanceKm);
}
async function offerNextDriver(ride) {
  if (ride.status === 'ACCEPTED' || ride.status === 'CANCELLED') return;
  const next=candidateDrivers(ride).find(d=>!ride.offeredDriverIds.has(d.driverId));
  if (!next) { ride.status='NO_DRIVER'; ride.currentDriverId=null; return; }
  ride.offeredDriverIds.add(next.driverId);
  ride.currentDriverId=next.driverId;
  ride.status='OFFERING';
  ride.offerExpiresAt=Date.now()+OFFER_TTL_MS;
  const sent=sendToDriver(next.driverId,{type:'RIDE_OFFER',rideId:ride.id,pickup:ride.pickup,destination:ride.destination,distanceToPickupKm:Number(next.distanceKm.toFixed(2)),expiresAt:ride.offerExpiresAt});
  if (!sent) { ride.currentDriverId=null; ride.status='SEARCHING'; return offerNextDriver(ride); }
}

app.get('/health',(_req,res)=>res.json({ok:true,service:'rotas-go-dispatch-test',version:'6.0',driversOnline:activeDrivers().length,connections:connections.size,rides:rides.size}));
app.get('/api/version',(_req,res)=>res.json({ok:true,version:'6.0-dispatch',mode:'device-geolocation+websocket+nearest-driver'}));

app.post('/api/location/update',(req,res)=>{
  const driverId=String(req.body?.driverId||'').trim(); const lat=Number(req.body?.lat); const lng=Number(req.body?.lng); const accuracy=req.body?.accuracy!=null?Number(req.body.accuracy):null;
  if(!driverId) return json(res,400,{ok:false,error:'driverId_obrigatorio'});
  if(!Number.isFinite(lat)||!Number.isFinite(lng)||Math.abs(lat)>90||Math.abs(lng)>180) return json(res,400,{ok:false,error:'coordenadas_invalidas'});
  const now=Date.now(); const location={driverId,lat,lng,accuracy:Number.isFinite(accuracy)?accuracy:null,status:'AVAILABLE',updatedAt:now,expiresAt:now+LOCATION_TTL_MS};
  locations.set(driverId,location); return json(res,200,{ok:true,saved:true,location});
});
app.post('/api/driver/offline',(req,res)=>{const id=String(req.body?.driverId||'').trim(); locations.delete(id); const ws=connections.get(id); if(ws) { try{ws.close();}catch{} connections.delete(id); } return res.json({ok:true,offline:true,driverId:id});});
app.get('/api/locations',(_req,res)=>json(res,200,{ok:true,count:activeDrivers().length,locations:activeDrivers().map(x=>({...x,ageSeconds:Math.round((Date.now()-x.updatedAt)/1000)}))}));

app.post('/api/rides',(req,res)=>{
  const pickup=req.body?.pickup, destination=req.body?.destination;
  if(!pickup||!Number.isFinite(Number(pickup.lat))||!Number.isFinite(Number(pickup.lng))) return json(res,400,{ok:false,error:'pickup_coordenadas_obrigatorias'});
  const ride={id:'RIDE-'+randomUUID().slice(0,8).toUpperCase(),pickup:{lat:Number(pickup.lat),lng:Number(pickup.lng),label:String(pickup.label||'Origem')},destination:{lat:Number(destination?.lat),lng:Number(destination?.lng),label:String(destination?.label||'Destino')},status:'SEARCHING',currentDriverId:null,offeredDriverIds:new Set(),createdAt:Date.now(),offerExpiresAt:0};
  rides.set(ride.id,ride); offerNextDriver(ride).catch(console.error);
  return json(res,201,{ok:true,ride:serializeRide(ride)});
});
function serializeRide(r){return {...r,offeredDriverIds:[...r.offeredDriverIds]};}
app.get('/api/rides/:id',(req,res)=>{const r=rides.get(req.params.id); if(!r)return json(res,404,{ok:false,error:'corrida_nao_encontrada'}); return json(res,200,{ok:true,ride:serializeRide(r)});});
app.post('/api/rides/:id/respond',(req,res)=>{
  const r=rides.get(req.params.id); const driverId=String(req.body?.driverId||'').trim(); const action=String(req.body?.action||'').toUpperCase();
  if(!r)return json(res,404,{ok:false,error:'corrida_nao_encontrada'});
  if(r.currentDriverId!==driverId)return json(res,409,{ok:false,error:'oferta_nao_pertence_ao_motorista'});
  if(r.status!=='OFFERING'||r.offerExpiresAt<=Date.now()) return json(res,409,{ok:false,error:'oferta_expirada'});
  if(action==='ACCEPT') {r.status='ACCEPTED';r.acceptedDriverId=driverId;r.offerExpiresAt=0; return res.json({ok:true,ride:serializeRide(r)});}
  if(action==='REJECT') {r.status='SEARCHING';r.currentDriverId=null;r.offerExpiresAt=0;offerNextDriver(r).catch(console.error);return res.json({ok:true,rejected:true,ride:serializeRide(r)});}
  return json(res,400,{ok:false,error:'action_deve_ser_ACCEPT_ou_REJECT'});
});

wss.on('connection',(ws,req)=>{
  const url=new URL(req.url,'http://localhost'); const driverId=String(url.searchParams.get('driverId')||'').trim();
  if(!driverId){ws.close(1008,'driverId_obrigatorio');return;}
  connections.set(driverId,ws);
  ws.send(JSON.stringify({type:'CONNECTED',driverId}));
  ws.on('message',raw=>{try{const m=JSON.parse(raw.toString());if(m.type==='PING')ws.send(JSON.stringify({type:'PONG',at:Date.now()}));}catch{}});
  ws.on('close',()=>{if(connections.get(driverId)===ws)connections.delete(driverId);});
  ws.on('error',()=>{if(connections.get(driverId)===ws)connections.delete(driverId);});
});

setInterval(cleanExpired,5000);
server.listen(PORT,()=>console.log(`[Rotas GO] Dispatch Test 6.0 on port ${PORT}`));
