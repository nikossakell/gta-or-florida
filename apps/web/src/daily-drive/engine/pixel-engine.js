/*
 * Daily Drive pixel engine (ES module). Original art; no third-party assets.
 * Renders Gus the gator, the convertible, the 5-zone road map, detours and postcard scenes
 * from code, so every asset is reproducible and resolution-independent.
 * Requires a browser (canvas). Import once; sprites are built on first import.
 */
export const ZONES=[{n:'Welcome to Florida',s:'Welcome'},{n:'Ocean Drive',s:'Ocean'},{n:'Seven Mile Bridge',s:'Bridge'},{n:'Everglades',s:'Glades'},{n:'Vice Skyline',s:'Vice'}];
export const DETOUR=['DETOUR: wrong exit, classic','DETOUR: rollerblade parade','DETOUR: the old bridge. Bold.','DETOUR: gator has right of way','DETOUR: valet took the long way'];
export const ICON={ok:'<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1.5 5.5l2.5 2.5 4.5-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="square"/></svg>',bad:'<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" stroke-width="2.4" stroke-linecap="square"/></svg>'};
let _rm=()=>typeof matchMedia!=='undefined'&&matchMedia('(prefers-reduced-motion: reduce)').matches;
/** Override reduced-motion detection (e.g. from an in-app setting). */
export function setReducedMotion(fn){_rm=fn;}
const RM=()=>_rm();
/* ================= PIXEL ENGINE ================= */
const PAL={o:'#140F2B',g:'#41B465',d:'#22693F',l:'#9BE28E',c:'#FFF1D6',s:'#E6C796',k:'#0B0816',p:'#FF5FA2',q:'#B8236B',t:'#2DE2C8',w:'#FFFFFF',r:'#D93A55',y:'#FFD25A',b:'#8EE6FF',e:'#9A8FB5'};
const grid=(w,h)=>Array.from({length:h},()=>Array(w).fill(''));
function R(g,x,y,w,h,c){for(let j=y;j<y+h;j++){const row=g[j];if(!row)continue;for(let i=x;i<x+w;i++)if(i>=0&&i<row.length)row[i]=c;}}
function P(g,pts,c){for(const [x,y] of pts){if(g[y]&&x>=0&&x<g[y].length)g[y][x]=c;}}
function FX(g,pts,c){for(const [x,y] of pts){if(g[y]&&x>=0&&x<g[y].length&&!g[y][x])g[y][x]=c;}}
function outline(g){const o=g.map(r=>r.slice());for(let y=0;y<g.length;y++)for(let x=0;x<g[0].length;x++){if(g[y][x])continue;if(g[y][x-1]||g[y][x+1]||(g[y-1]&&g[y-1][x])||(g[y+1]&&g[y+1][x]))o[y][x]='o';}return o;}
function toCanvas(g,sc=1){const c=document.createElement('canvas');c.width=g[0].length*sc;c.height=g.length*sc;const x=c.getContext('2d');for(let j=0;j<g.length;j++)for(let i=0;i<g[0].length;i++){const k=g[j][i];if(!k)continue;x.fillStyle=PAL[k]||k;x.fillRect(i*sc,j*sc,sc,sc);}return c;}

/* --- Gus the gator, 32x32 --- */
function gBody(g,t){R(g,3,25,6,3,'g');R(g,4,27,4,1,'d');R(g,1,t?23:22,2,4,'g');R(g,8,16,10,11,'g');R(g,8,16,2,11,'d');P(g,[[7,18],[7,21],[7,24]],'g');R(g,11,17,6,9,'c');R(g,11,19,6,1,'s');R(g,11,22,6,1,'s');R(g,8,27,4,2,'g');R(g,14,27,4,2,'g');P(g,[[8,28],[10,28],[14,28],[16,28]],'l');}
function gHead(g,dy){R(g,8,5+dy,9,11,'g');R(g,9,3+dy,6,2,'g');R(g,17,8+dy,11,4,'g');R(g,18,8+dy,9,1,'l');R(g,26,7+dy,2,1,'g');P(g,[[27,8+dy]],'d');R(g,16,12+dy,11,2,'l');R(g,15,11+dy,2,3,'g');P(g,[[10,13+dy],[12,14+dy],[9,11+dy],[14,4+dy],[11,3+dy]],'d');}
function smirk(g,dy){R(g,17,11+dy,10,1,'d');P(g,[[17,10+dy]],'d');P(g,[[19,12+dy],[22,12+dy],[25,12+dy]],'w');}
function grin(g,dy){R(g,17,11+dy,10,1,'d');P(g,[[17,10+dy],[16,10+dy]],'d');for(let x=18;x<27;x+=2)P(g,[[x,12+dy]],'w');}
function frown(g,dy){R(g,18,11+dy,9,1,'d');P(g,[[17,12+dy],[16,13+dy]],'d');P(g,[[21,12+dy]],'w');}
function openMouth(g,dy){R(g,16,13+dy,11,2,'l');R(g,17,12+dy,9,1,'r');R(g,17,11+dy,10,1,'d');P(g,[[19,12+dy],[23,12+dy],[21,13+dy],[25,13+dy]],'w');}
function clench(g,dy){R(g,17,11+dy,10,1,'d');P(g,[[19,10+dy],[23,10+dy]],'d');for(let x=18;x<26;x++)P(g,[[x,12+dy]],x%2?'w':'d');}
function shades(g,dy,o={}){const d=o.drop||0,k=o.skew?1:0,f=o.f||0;R(g,9,6+dy+d,4,3,'k');R(g,14,6+dy+d+k,4,3,'k');P(g,[[13,7+dy+d],[8,7+dy+d]],'k');P(g,[[10+f,6+dy+d],[11+f,7+dy+d]],'p');P(g,[[15+f,6+dy+d+k],[16+f,7+dy+d+k]],'t');if(o.shine)P(g,[[9,8+dy+d],[10,7+dy+d],[11,6+dy+d],[14,8+dy+d],[15,7+dy+d],[16,6+dy+d]],'w');}
const armRest=g=>{R(g,16,18,3,4,'g');R(g,17,22,2,1,'l');};
const armThumb=g=>{R(g,17,18,4,2,'g');R(g,21,17,3,3,'l');R(g,22,15,2,2,'l');};
const armFist=g=>{R(g,17,18,4,2,'g');R(g,21,16,3,3,'l');};
const armBackUp=g=>{R(g,6,15,2,2,'g');R(g,4,7,2,9,'g');R(g,3,4,4,3,'l');};
const armScratch=g=>{R(g,6,15,2,2,'g');R(g,5,8,2,8,'g');R(g,6,3,4,3,'l');};
const spark=(x,y)=>[[x,y],[x-1,y],[x+1,y],[x,y-1],[x,y+1]];
function gator(st,f){
 let g=grid(32,32);const t=f===1;
 if(st==='idle'){gBody(g,t);gHead(g,t?1:0);smirk(g,t?1:0);shades(g,t?1:0,{f:t?1:0});armRest(g);}
 else if(st==='correct'){gBody(g,t);gHead(g,0);grin(g,0);shades(g,0,{f:t?1:0});armThumb(g);}
 else if(st==='wrong'){gBody(g,false);gHead(g,0);frown(g,0);shades(g,0,{skew:true});armScratch(g);}
 else if(st==='streak'){gBody(g,t);gHead(g,0);openMouth(g,0);shades(g,0,{shine:!t,f:t?1:0});armFist(g);armBackUp(g);}
 else if(st==='nervous'){gBody(g,false);gHead(g,0);clench(g,0);shades(g,0,{f:t?1:0});armRest(g);}
 else if(st==='perfect'){gBody(g,t);gHead(g,0);openMouth(g,0);shades(g,0,{shine:true});armFist(g);armBackUp(g);}
 else if(st==='low'){gBody(g,false);gHead(g,1);frown(g,1);shades(g,1,{drop:2});P(g,[[10,8],[11,8],[15,8],[16,8]],'w');P(g,[[10,7],[11,7],[15,7],[16,7]],'d');P(g,[[11,8],[16,8]],'k');armRest(g);}
 g=outline(g);
 if(st==='correct')FX(g,t?spark(27,13):spark(26,11),'y');
 if(st==='wrong')FX(g,[[1,0],[2,0],[0,1],[3,1],[3,2],[2,3],[2,5]].map(([x,y])=>[x+21,y+(t?0:1)]),'y');
 if(st==='streak')FX(g,[...spark(t?29:2,t?3:11),...spark(t?2:29,t?12:2)],'y');
 if(st==='nervous')FX(g,t?[[6,5],[6,6],[19,5],[19,6]]:[[6,3],[6,4],[19,3],[20,4]],'b');
 if(st==='perfect'){const A=t?[[2,2,'p'],[28,3,'t'],[24,1,'y'],[1,12,'y'],[29,17,'p'],[5,0,'t'],[30,9,'y']]:[[3,1,'t'],[29,2,'y'],[23,2,'p'],[1,10,'p'],[29,14,'t'],[6,1,'y'],[30,6,'p']];for(const [x,y,c] of A)FX(g,[[x,y],[x+1,y],[x,y+1],[x+1,y+1]],c);}
 if(st==='low'){FX(g,[[19,0],[20,0],[21,0],[22,0],[23,0],[18,1],[19,1],[20,1],[21,1],[22,1],[23,1],[24,1]],'e');FX(g,t?[[20,3],[23,4]]:[[20,4],[23,3]],'b');}
 return g;
}
/* --- convertible, 30x15 --- */
function car(f){const g=grid(30,15);
 R(g,2,8,26,3,'p');R(g,2,11,26,1,'q');R(g,2,6,7,2,'p');R(g,20,7,8,1,'p');R(g,3,9,24,1,'c');P(g,[[27,8]],'y');P(g,[[2,8]],'r');
 R(g,19,4,1,3,'t');P(g,[[18,3]],'t');R(g,9,5,2,3,'c');
 R(g,12,2,4,5,'g');R(g,16,4,3,2,'g');R(g,13,3,3,1,'k');P(g,[[15,3]],'p');
 for(const x of [4,20]){R(g,x,11,5,4,'k');P(g,[[x,11],[x+4,11],[x,14],[x+4,14]],'');R(g,x+1,12,3,2,'e');P(g,[[x+1+(f?2:0),12+(f?1:0)]],'w');}
 return outline(g);}

const STATES=['idle','correct','wrong','streak','nervous','perfect','low'];
const GC={},SPR={};
for(const s of STATES){GC[s]=[0,1].map(f=>toCanvas(gator(s,f)));SPR[s]=GC[s].map(c=>c.toDataURL());}
const CARC=[0,1].map(f=>toCanvas(car(f)));const CARU=CARC.map(c=>c.toDataURL());

/* ================= SCENERY ================= */
const WW=840,FARW=720;
const F=(c,col,x,y,w,h)=>{c.fillStyle=col;c.fillRect(x,y,w,h);};
let seed=1;const rnd=()=>{seed=(seed*16807)%2147483647;return (seed-1)/2147483646;};
function sun(c,cx,hz,r){for(let y=hz-r;y<hz;y++){const d=hz-y;if([1,2,4,5,8,12].includes(d))continue;const hw=Math.floor(Math.sqrt(r*r-d*d));const k=(y-(hz-r))/r;F(c,k<.35?'#FFD25A':k<.6?'#FF9F45':k<.8?'#FF6E6E':'#FF5FA2',cx-hw,y,hw*2,1);}}
function skyBands(c,W,hz,night){const cols=night?['#0B0820','#120C2A','#1A1036','#24124A','#33185A','#4A1F63','#6B2468']:['#140F2B','#1D1340','#2B1852','#431D61','#6B2468','#A42F6C','#E0476A'];for(let i=0;i<cols.length;i++){const a=Math.round(hz*i/cols.length),b=Math.round(hz*(i+1)/cols.length);F(c,cols[i],0,a,W,b-a);}for(let i=0;i<(night?60:26);i++)F(c,rnd()<.7?'#FFF1D6':'#8EE6FF',Math.floor(rnd()*W),Math.floor(rnd()*hz*.55),1,1);}
function palm(c,x,by,h,trunk,fr){let tx=x;for(let i=0;i<h;i++){tx=x+Math.round(Math.sin(i/h*1.2)*3);F(c,trunk,tx,by-i,2,1);}const ty=by-h;F(c,fr,tx-6,ty,6,1);F(c,fr,tx-7,ty+1,2,2);F(c,fr,tx+2,ty,6,1);F(c,fr,tx+7,ty+1,2,2);F(c,fr,tx-3,ty-2,4,1);F(c,fr,tx+1,ty-2,4,1);F(c,fr,tx-1,ty-3,3,1);F(c,fr,tx-5,ty+1,1,2);F(c,fr,tx+6,ty+1,1,2);}
function drawFar(c){seed=7;skyBands(c,FARW,40,false);sun(c,250,40,22);F(c,'#24163F',0,38,FARW,26);for(let x=0;x<FARW;x+=6)F(c,'#24163F',x,34+Math.floor(rnd()*4),6,4);for(const x of [60,90,330,470,520,640])palm(c,x,38,10,'#1A0F33','#1A0F33');}
function building(c,x,w,h,col,trim){const top=40-h;F(c,col,x,top,w,h);F(c,col,x+3,top-3,w-6,3);F(c,col,x+(w>>1)-2,top-6,4,3);F(c,'rgba(0,0,0,.16)',x+w-3,top,3,h);F(c,trim,x,top+3,w,1);for(let y=top+6;y<36;y+=5)for(let i=x+3;i<x+w-4;i+=5)F(c,rnd()<.25?'#FFF1D6':'#3E2A6E',i,y,2,2);F(c,'#3E2A6E',x+(w>>1)-2,36,4,4);}
function mangrove(c,x,y,w,h){F(c,'#2C5B3A',x,y,w,h);F(c,'#2C5B3A',x+2,y-3,w-4,3);F(c,'#3E7A4C',x+3,y-2,5,2);F(c,'#3E7A4C',x+w-8,y+1,4,2);for(let i=0;i<w-2;i+=3)F(c,'#5A4030',x+1+i,y+h,1,3);}
function gatorEyes(c,x,y){F(c,'#41B465',x,y,6,2);F(c,'#41B465',x+6,y+1,5,1);F(c,'#FFD25A',x+1,y,1,1);F(c,'#FFD25A',x+4,y,1,1);}
const DOFF=['#5A3E2A','#C9A06A','#5E5678','#6B4A2A','#3A2560'];
function detour(c,z,used){const x0=z*160,col=used?'#FF8A3D':DOFF[z];const dash=used?1:2;
 for(let k=0;k<6;k++){F(c,col,x0+14+k*2,52+k,3,1);F(c,col,x0+134+k*2,57-k,3,1);}
 for(let x=x0+24;x<x0+136;x+=dash*2)F(c,col,x,57,dash*2-(used?0:1),3);
 if(z===2&&!used)F(c,'#1A8CA3',x0+70,57,14,3);
 if(used){for(let x=x0+26;x<x0+134;x+=6)F(c,'#FFF1D6',x,58,2,1);F(c,'#6B4A2A',x0+30,49,1,8);F(c,'#FF8A3D',x0+26,45,9,4);F(c,'#140F2B',x0+28,46,5,1);F(c,'#140F2B',x0+28,48,3,1);}}
function drawNear(c,used){
 c.clearRect(0,0,WW,64);
 seed=3;
 /* zone 1: welcome */
 F(c,'#3E8E4E',0,40,160,4);F(c,'#2F7A44',0,52,160,12);for(let i=0;i<30;i++)F(c,'#4FA85E',Math.floor(rnd()*160),53+Math.floor(rnd()*10),2,1);
 for(const x of [14,56,132])palm(c,x,43,16,'#8A5A33','#3FBF6A');
 F(c,'#6B4A2A',84,32,2,12);F(c,'#6B4A2A',106,32,2,12);F(c,'#FFF1D6',80,21,32,12);F(c,'#FF8A3D',80,21,32,1);F(c,'#FF8A3D',80,32,32,1);F(c,'#FF8A3D',80,21,1,12);F(c,'#FF8A3D',111,21,1,12);F(c,'#FF8A3D',83,24,5,5);F(c,'#2DE2C8',91,24,17,1);F(c,'#2DE2C8',93,26,15,1);F(c,'#FF5FA2',91,29,17,1);
 /* zone 2: ocean drive */
 F(c,'#E9C9A6',160,40,160,4);F(c,'#F3D29A',160,52,160,5);F(c,'#1FA6B8',160,57,160,7);for(let i=0;i<20;i++)F(c,'#8EE6FF',160+Math.floor(rnd()*156),58+Math.floor(rnd()*5),3,1);
 [[164,24,22,'#FF9EC4','#2DE2C8'],[190,20,18,'#8FE3C8','#FF5FA2'],[212,30,26,'#B9A3F5','#2DE2C8'],[242,22,20,'#FFD27A','#FF5FA2'],[266,26,22,'#FFB38A','#2DE2C8'],[292,18,24,'#9EC9FF','#FF5FA2']].forEach(([x,w,h,col,tr])=>building(c,x,w,h,col,tr));
 /* zone 3: seven mile bridge */
 F(c,'#1E9BB0',320,38,160,6);F(c,'#8EE6FF',320,38,160,1);F(c,'#2F7A44',350,36,14,2);F(c,'#2F7A44',353,35,8,1);palm(c,356,35,5,'#8A5A33','#3FBF6A');F(c,'#2F7A44',430,36,10,2);
 F(c,'#1A8CA3',320,52,160,12);for(let i=0;i<22;i++)F(c,'#8EE6FF',320+Math.floor(rnd()*156),53+Math.floor(rnd()*10),3,1);for(let x=326;x<480;x+=18){F(c,'#6E6488',x,52,3,12);F(c,'#4B4366',x+3,52,1,12);}
 /* zone 4: everglades */
 F(c,'#5E7F35',480,40,160,4);for(let i=0;i<70;i++)F(c,'#7FA346',480+Math.floor(rnd()*160),37+Math.floor(rnd()*3),1,3);
 mangrove(c,488,28,20,10);mangrove(c,546,25,26,12);mangrove(c,606,29,20,9);
 F(c,'#2F5D50',480,52,160,12);for(let i=0;i<10;i++)F(c,'#6FAF5A',480+Math.floor(rnd()*150),54+Math.floor(rnd()*9),3,1);gatorEyes(c,505,61);gatorEyes(c,590,60);
 /* zone 5: vice skyline */
 F(c,'#1B0F33',640,40,200,4);F(c,'#120A26',640,52,200,12);for(const y of [55,59,63])F(c,'#5A1F5C',640,y,200,1);for(let x=640;x<840;x+=12)F(c,'#5A1F5C',x,52,1,12);
 for(let x=640;x<838;){const w=8+Math.floor(rnd()*11),h=12+Math.floor(rnd()*22),top=40-h,col=rnd()<.5?'#2A1650':'#33195E';F(c,col,x,top,w,h);if(rnd()<.45)F(c,rnd()<.5?'#FF5FA2':'#2DE2C8',x,top,w,1);for(let y=top+3;y<38;y+=3)for(let i=x+1;i<x+w-1;i+=3)if(rnd()<.35)F(c,['#FF5FA2','#2DE2C8','#FFD25A'][Math.floor(rnd()*3)],i,y,1,1);x+=w+1;}
 for(let x=652;x<790;x+=34){F(c,'#6E6488',x,30,1,14);F(c,'#FFD25A',x-1,30,3,1);F(c,'rgba(255,210,90,.22)',x-3,31,7,5);}
 F(c,'#FFF1D6',798,18,2,26);F(c,'#FFF1D6',834,18,2,26);for(let i=0;i<12;i++)for(let j=0;j<2;j++)F(c,(i+j)%2?'#FFF1D6':'#140F2B',800+i*3,18+j*3,3,3);
 /* road */
 F(c,'#2B2240',0,44,WW,8);F(c,'#3D3160',0,44,WW,1);F(c,'#1B1430',0,51,WW,1);for(let x=2;x<WW;x+=10)F(c,'#FFF1D6',x,47,5,1);
 F(c,'#FFF1D6',320,42,160,1);for(let x=320;x<480;x+=6)F(c,'#FFF1D6',x,42,1,2);
 F(c,'#8A5A33',480,42,160,1);for(let x=480;x<640;x+=8)F(c,'#8A5A33',x,42,1,2);
 F(c,'#2DE2C8',640,44,200,1);F(c,'#FF5FA2',640,51,200,1);
 for(let z=0;z<5;z++)detour(c,z,used[z]);
}

/* ================= DRIVE MAP ================= */
const stopX=k=>k===0?4:k*160-14;
const smooth=x=>x<=0?0:x>=1?1:x*x*(3-2*x);
class DriveMap{
 constructor(root,attract){
  this.root=root;this.attract=attract;
  root.innerHTML='<div class="layer far"><canvas width="'+FARW+'" height="64"></canvas></div><div class="layer world"><canvas width="'+WW+'" height="64"></canvas><div class="cps"></div><div class="tags"></div><div class="carwrap"><span class="flame" aria-hidden="true"></span><img alt="" class="sprite"></div><div class="sign" hidden></div></div>';
  this.farEl=root.querySelector('.far');this.farC=this.farEl.firstChild;this.world=root.querySelector('.world');this.nearC=this.world.firstChild;
  this.carEl=root.querySelector('.carwrap');this.carImg=this.carEl.querySelector('img');this.sign=root.querySelector('.sign');
  drawFar(this.farC.getContext('2d'));
  this.used=[0,0,0,0,0];this.marks=['','','','',''];this.carX=stopX(0);this.carY=0;this.s=2;this.vw=300;this.wf=0;this.moving=false;
  this.redraw();this.carImg.src=CARU[0];
  this.tags=ZONES.map((z,i)=>{const t=document.createElement('span');t.className='tag';t.textContent=(i+1)+' '+z.n.toUpperCase();this.world.appendChild(t);return t;});
  this.cps=[];if(!attract){for(let k=1;k<=5;k++){const e=document.createElement('span');e.className='cp pending';e.textContent=k;this.world.querySelector('.cps').appendChild(e);this.cps.push(e);}}
  this.ro=new ResizeObserver(()=>this.layout());this.ro.observe(root);
  if(attract){const loop=now=>{if(this.dead)return;if(root.offsetParent!==null){if(RM()){this.carX=40;}else{this.carX=4+((now/1000*26)%790);this.spin(now);}this.place();}requestAnimationFrame(loop);};requestAnimationFrame(loop);}
 }
 destroy(){this.dead=true;this.ro.disconnect();this.root.innerHTML='';}
 redraw(){drawNear(this.nearC.getContext('2d'),this.used);}
 layout(){const h=this.root.clientHeight;if(!h)return;const s=this.s=h/64;this.vw=this.root.clientWidth/s;
  this.nearC.style.width=WW*s+'px';this.nearC.style.height=64*s+'px';this.farC.style.width=FARW*s+'px';this.farC.style.height=64*s+'px';
  this.carImg.style.width=30*s+'px';this.carImg.style.height=15*s+'px';
  this.tags.forEach((t,i)=>{t.style.left=(i*160+3)*s+'px';});
  this.cps.forEach((e,i)=>{const k=i+1,sz=Math.round(10*s);e.style.width=e.style.height=sz+'px';e.style.left=((k*160-5)*s-sz/2)+'px';e.style.top=(26*s)+'px';});
  this.place();}
 place(){const s=this.s;const cam=Math.max(0,Math.min(this.carX+15-this.vw*.35,WW-this.vw));
  this.world.style.transform=`translate3d(${-cam*s}px,0,0)`;
  const fo=RM()?0:Math.min(cam*.35,FARW-this.vw);this.farEl.style.transform=`translate3d(${-Math.max(0,fo)*s}px,0,0)`;
  this.carEl.style.transform=`translate3d(${this.carX*s}px,${(36+this.carY)*s}px,0)`;
  if(!this.sign.hidden){this.sign.style.left=(this.carX+8)*s+'px';this.sign.style.top=Math.max(2,(26+this.carY)*s-22)+'px';}}
 spin(now){const f=Math.floor(now/90)%2;if(f!==this.wf){this.wf=f;this.carImg.src=CARU[f];}}
 setTurbo(on){this.carEl.classList.toggle('turbo',!!on&&!RM());}
 setMark(k,st){this.marks[k-1]=st;this.used[k-1]=st==='bad'?1:0;this.redraw();const e=this.cps[k-1];if(e){e.className='cp '+(st||'pending');e.innerHTML=st==='ok'?ICON.ok:st==='bad'?ICON.bad:String(k);e.setAttribute('aria-label',`Checkpoint ${k}: ${st==='ok'?'correct':st==='bad'?'wrong, detour':'not reached'}`);}}
 reset(){for(let k=1;k<=5;k++)this.setMark(k,'');this.carX=stopX(0);this.carY=0;this.setTurbo(false);this.sign.hidden=true;this.layout();}
 jump(k){this.carX=stopX(k);this.carY=0;this.place();}
 drive(to,wrong,done){
  const x0=this.carX,x1=stopX(to),zone=to-1,zx=zone*160,dur=RM()?0:1200,t0=performance.now();this.moving=true;
  if(wrong&&!RM()){this.sign.textContent=DETOUR[zone];this.sign.hidden=false;}
  const step=now=>{const t=dur?Math.min(1,(now-t0)/dur):1;const e=t<.5?2*t*t:1-Math.pow(-2*t+2,2)/2;this.carX=x0+(x1-x0)*e;
   if(wrong){const d=this.carX+15-zx;this.carY=9*smooth((d-14)/12)*(1-smooth((d-134)/12));}else this.carY=0;
   this.spin(now);this.place();
   if(t<1)requestAnimationFrame(step);else{this.moving=false;this.carY=0;this.place();setTimeout(()=>{this.sign.hidden=true;},500);done&&done();}};
  requestAnimationFrame(step);}
}

/* ================= POSTCARD ART ================= */
const TINY={M:['101','111','101','101','101'],O:['111','101','101','101','111'],T:['111','010','010','010','010'],E:['111','100','110','100','111'],L:['100','100','100','100','111']};
function tiny(c,str,x,y,sc,col){[...str].forEach((ch,i)=>TINY[ch].forEach((row,j)=>[...row].forEach((v,k)=>{if(v==='1')F(c,col,x+(i*4+k)*sc,y+j*sc,sc,sc);})));}
function fireworks(c,cx,cy,col){for(let a=0;a<8;a++){const dx=Math.round(Math.cos(a*Math.PI/4)*6),dy=Math.round(Math.sin(a*Math.PI/4)*6);F(c,col,cx+dx,cy+dy,1,1);F(c,col,cx+Math.round(dx/2),cy+Math.round(dy/2),1,1);}F(c,'#FFF1D6',cx,cy,1,1);}
function roadStrip(c,y,h){F(c,'#2B2240',0,y,192,h);F(c,'#3D3160',0,y,192,1);for(let x=4;x<192;x+=12)F(c,'#FFF1D6',x,y+(h>>1),6,1);}
function drawArt(cv,key){const c=cv.getContext('2d');c.imageSmoothingEnabled=false;c.clearRect(0,0,192,108);seed=11;
 if(key==='vice'){skyBands(c,192,70,true);fireworks(c,34,18,'#FF5FA2');fireworks(c,162,14,'#2DE2C8');fireworks(c,138,32,'#FFD25A');
  for(let x=0;x<192;){const w=10+Math.floor(rnd()*14),h=20+Math.floor(rnd()*30);F(c,'#2A1650',x,72-h,w,h);for(let y=74-h;y<70;y+=3)for(let i=x+1;i<x+w-1;i+=3)if(rnd()<.35)F(c,['#FF5FA2','#2DE2C8','#FFD25A'][Math.floor(rnd()*3)],i,y,1,1);x+=w+1;}
  F(c,'#3A1F70',78,14,36,58);F(c,'#FF5FA2',78,14,1,58);F(c,'#2DE2C8',113,14,1,58);F(c,'#2DE2C8',82,11,28,3);F(c,'#FFF1D6',82,10,28,1);palm(c,86,10,6,'#8A5A33','#3FBF6A');for(let y=18;y<70;y+=4)for(let x=82;x<110;x+=4)F(c,rnd()<.6?'#FFD25A':'#24124A',x,y,2,2);
  F(c,'#120A26',0,72,192,36);roadStrip(c,80,10);for(const y of [94,100,106])F(c,'#5A1F5C',0,y,192,1);c.drawImage(CARC[0],126,73);}
 else if(key==='veteran'){skyBands(c,192,62,false);sun(c,132,62,26);F(c,'#1FA6B8',96,62,96,14);for(let y=63;y<76;y+=2)F(c,'#FF9F45',118,y,28-(y-62)*2>0?28-(y-62):4,1);
  [[0,20,26,'#FF9EC4','#2DE2C8'],[22,18,32,'#8FE3C8','#FF5FA2'],[42,22,24,'#B9A3F5','#2DE2C8'],[66,24,28,'#FFD27A','#FF5FA2']].forEach(([x,w,h,col,tr])=>{const top=62-h;F(c,col,x,top,w,h);F(c,col,x+3,top-3,w-6,3);F(c,tr,x,top+3,w,1);for(let y=top+6;y<58;y+=5)for(let i=x+3;i<x+w-4;i+=5)F(c,'#3E2A6E',i,y,2,2);});
  roadStrip(c,62,10);F(c,'#F3D29A',0,72,192,36);F(c,'#1FA6B8',150,76,42,32);for(let i=0;i<12;i++)F(c,'#8EE6FF',152+Math.floor(rnd()*36),78+Math.floor(rnd()*28),3,1);
  F(c,'#6B4A2A',112,72,1,22);for(let i=0;i<9;i++)F(c,i%2?'#FFF1D6':'#FF5FA2',104+i*2,70-Math.min(i,8-i),2,3+Math.min(i,8-i));F(c,'#2DE2C8',96,92,16,4);c.drawImage(CARC[0],34,54);palm(c,140,72,18,'#8A5A33','#3FBF6A');}
 else if(key==='tourist'){skyBands(c,192,64,false);sun(c,40,64,14);palm(c,8,70,22,'#8A5A33','#3FBF6A');
  F(c,'#E9C9A6',16,46,124,24);F(c,'#FF8A3D',12,42,132,4);for(let i=0;i<6;i++){F(c,'#2DE2C8',22+i*19,56,7,14);F(c,'#3E2A6E',31+i*19,52,6,5);F(c,'#140F2B',24+i*19,53,3,2);}
  F(c,'#6E6488',160,24,3,46);F(c,'#140F2B',140,8,44,18);F(c,'#FF5FA2',140,8,44,1);F(c,'#FF5FA2',140,25,44,1);F(c,'#FF5FA2',140,8,1,18);F(c,'#FF5FA2',183,8,1,18);tiny(c,'MOTEL',143,12,2,'#FF5FA2');
  for(let i=0;i<5;i++)F(c,'#FFD25A',150+i*4,30,2,2);F(c,'#2B2240',0,70,192,38);for(let x=10;x<192;x+=26)F(c,'#FFF1D6',x,76,1,14);c.drawImage(CARC[0],62,78);}
 else if(key==='glades'){skyBands(c,192,58,false);F(c,'#3E5B3E',0,50,192,8);mangrove(c,6,38,30,14);mangrove(c,120,36,36,16);mangrove(c,168,42,24,10);
  F(c,'#244A3F',0,58,192,50);for(let i=0;i<26;i++)F(c,'#3F6E5C',Math.floor(rnd()*188),60+Math.floor(rnd()*46),4,1);for(let i=0;i<8;i++)F(c,'#6FAF5A',Math.floor(rnd()*180),64+Math.floor(rnd()*40),3,1);
  c.drawImage(CARC[0],70,56);F(c,'#244A3F',66,66,40,10);F(c,'#3F6E5C',64,66,44,1);F(c,'#8EE6FF',80,62,1,1);F(c,'#8EE6FF',84,60,1,1);gatorEyes(c,26,82);gatorEyes(c,134,74);gatorEyes(c,160,94);F(c,'rgba(200,230,255,.12)',0,52,192,3);F(c,'rgba(200,230,255,.10)',0,72,192,2);}
 else{skyBands(c,192,60,false);sun(c,150,60,28);F(c,'#24163F',0,56,192,4);roadStrip(c,60,14);F(c,'#6B4A2A',0,74,192,34);for(let i=0;i<30;i++)F(c,'#8A5A33',Math.floor(rnd()*190),76+Math.floor(rnd()*30),2,1);
  c.drawImage(CARC[0],50,64);F(c,'#FF5FA2',70,62,9,2);F(c,'#B8236B',70,64,1,6);F(c,'#140F2B',70,75,6,3);
  for(const [x,y,s] of [[74,52,6],[78,42,8],[86,30,10]]){F(c,'#9A8FB5',x,y,s,s);F(c,'#C9BBE8',x+1,y+1,s-3,s-3);}
  c.drawImage(GC.low[0],92,62,32,32);F(c,'#FF8A3D',36,88,8,2);F(c,'#FF8A3D',38,82,4,6);F(c,'#FFF1D6',38,85,4,1);F(c,'#FF8A3D',39,79,2,3);}
}


/** Pixel grid -> SVG string (one rect per horizontal run, crisp edges). */
export function gridToSVG(g,{scale=1,title=''}={}){const W=g[0].length,H=g.length;let r='';for(let y=0;y<H;y++){let x=0;while(x<W){const k=g[y][x];if(!k){x++;continue;}let e=x;while(e+1<W&&g[y][e+1]===k)e++;r+=`<rect x="${x}" y="${y}" width="${e-x+1}" height="1" fill="${PAL[k]||k}"/>`;x=e+1;}}
 return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W*scale}" height="${H*scale}" shape-rendering="crispEdges"${title?` role="img" aria-label="${title}"`:''}>${title?`<title>${title}</title>`:''}${r}</svg>`;}
/** Transparent 840x64 canvas holding only zone z's "used" detour route (overlay for the near layer). */
export function detourOverlay(z){const c=document.createElement('canvas');c.width=WW;c.height=64;detour(c.getContext('2d'),z,true);return c;}
/** Postcard scene keys in score order: 5,4,3,2,0-1. */
export const ENDING_KEYS=['vice','veteran','tourist','glades','fman'];
export const endingFor=sc=>sc>=5?'vice':sc===4?'veteran':sc===3?'tourist':sc===2?'glades':'fman';
export {PAL,grid,R,P,FX,outline,toCanvas,gator,car,STATES,GC,SPR,CARC,CARU,WW,FARW,sun,skyBands,palm,drawFar,drawNear,detour,drawArt,DriveMap,stopX};
