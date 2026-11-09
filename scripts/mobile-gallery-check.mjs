import puppeteer from "puppeteer-core";
const URL="http://localhost:8080/";const OUT="/opt/cursor/artifacts";
const W=420,H=820;
const L={executablePath:"/usr/bin/google-chrome-stable",headless:false,args:["--no-sandbox","--use-fake-device-for-media-stream","--use-fake-ui-for-media-stream",`--window-size=${W},${H}`]};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function nc(n,w,h){const b=await puppeteer.launch({...L,args:[...L.args.slice(0,3),`--window-size=${w},${h}`]});const p=await b.newPage();await p.setViewport({width:w,height:h});await p.goto(URL,{waitUntil:"domcontentloaded"});await p.type("#name-input",n);await p.click("#join-form button");return{b,p};}
(async()=>{const a=await nc("Alice",W,H);const c=await nc("Bob",1000,800);try{await sleep(2500);await a.p.click("#camera-btn");await c.p.click("#camera-btn");await sleep(7000);
const info=await a.p.evaluate(()=>{const sr=getComputedStyle(document.querySelector(".sidebar-rail"));return{room:document.getElementById("room-view").className,appW:Math.round(document.querySelector(".app").getBoundingClientRect().width),display:sr.display,cols:sr.gridTemplateColumns};});
console.log("MOBILE:",JSON.stringify(info));
await a.p.screenshot({path:`${OUT}/gallery_mobile.png`});
}finally{await a.b.close();await c.b.close();}})();
