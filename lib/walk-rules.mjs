export function walkPoints(meters) { return Number.isFinite(meters) && meters > 0 ? Math.floor(meters / 100) * 10 : 0; }
export function walkSegment(a, b) {
  const reliable = p => p && Number.isFinite(p.lat+p.lon+p.accuracy+p.time) && Math.abs(p.lat)<=90 && Math.abs(p.lon)<=180 && p.accuracy>0 && p.accuracy<=35;
  if(!reliable(a)||!reliable(b))return -1;
  const seconds=(b.time-a.time)/1000;if(seconds<=0||seconds>120)return -1;
  const radians=x=>x*Math.PI/180, h=Math.sin(radians(b.lat-a.lat)/2)**2+Math.cos(radians(a.lat))*Math.cos(radians(b.lat))*Math.sin(radians(b.lon-a.lon)/2)**2;
  const meters=6371000*2*Math.atan2(Math.sqrt(h),Math.sqrt(1-h));
  if(meters/seconds>3.2)return -1;
  return meters<Math.max(5,Math.min(20,(a.accuracy+b.accuracy)/2))?0:meters;
}
export function splitWalkDays(from,to,meters) {
  const result={};if(to<=from||!Number.isFinite(meters)||meters<0)return result;
  let cursor=from;
  while(cursor<to){const d=new Date(cursor),day=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;const end=Math.min(to,new Date(d.getFullYear(),d.getMonth(),d.getDate()+1).getTime());result[day]=(result[day]||0)+meters*(end-cursor)/(to-from);cursor=end;}
  return result;
}
