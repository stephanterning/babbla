import puppeteer from "puppeteer-core";
const URL="http://localhost:8080/";const OUT="/opt/cursor/artifacts";const W=1600,H=900;
const L={executablePath:"/usr/bin/google-chrome-stable",headless:false,args:["--no-sandbox","--use-fake-device-for-media-stream","--use-fake-ui-for-media-stream",`--window-size=${W},${H}`]};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function nc(n){const b=await puppeteer.launch(L);const p=await b.newPage();await p.setViewport({width:W,height:H});await p.goto(URL,{waitUntil:"domcontentloaded"});await p.type("#name-input",n);await p.click("#join-form button");return{b,p};}
(async()=>{const cs=[];for(const n of["Alice","Bob","Carol","Dave","Eve","Frank"]){cs.push(await nc(n));await sleep(800);}const a=cs[0];try{for(const c of cs)await c.p.click("#camera-btn");await sleep(9000);
const m=await a.p.evaluate(()=>{const rrailRows=[...document.querySelector(".sidebar-rail").children].filter(e=>e.style.gridColumn!=="1"&&e.id!=="video-grid");const ctrlTop=document.querySelector(".controls").getBoundingClientRect().top;const hdrTop=document.querySelector(".room-header").getBoundingClientRect().top;return{scrollH:document.documentElement.scrollHeight,railH:Math.round(document.querySelector(".sidebar-rail").getBoundingClientRect().height),gridH:Math.round(document.querySelector(".video-grid").getBoundingClientRect().height),tiles:document.querySelectorAll(".video-tile").length,headerToControlsGap:Math.round(ctrlTop-hdrTop)};});
console.log("MANY:",JSON.stringify(m));
await a.p.screenshot({path:`${OUT}/gallery_six_cams.png`,fullPage:true});
}finally{for(const c of cs)await c.b.close();}})();
