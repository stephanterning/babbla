import puppeteer from "puppeteer-core";
const URL="http://localhost:8080/";const W=1600,H=900;
const L={executablePath:"/usr/bin/google-chrome-stable",headless:false,args:["--no-sandbox","--use-fake-device-for-media-stream","--use-fake-ui-for-media-stream",`--window-size=${W},${H}`]};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function nc(n){const b=await puppeteer.launch(L);const p=await b.newPage();await p.setViewport({width:W,height:H});await p.goto(URL,{waitUntil:"domcontentloaded"});await p.type("#name-input",n);await p.click("#join-form button");return{b,p};}
(async()=>{const a=await nc("Alice");const c=await nc("Bob");try{await sleep(2500);await a.p.click("#camera-btn");await c.p.click("#camera-btn");await sleep(7000);
const m=await a.p.evaluate(()=>({scrollH:document.documentElement.scrollHeight,bodyH:document.body.getBoundingClientRect().height,railH:Math.round(document.querySelector(".sidebar-rail").getBoundingClientRect().height),gridH:Math.round(document.querySelector(".video-grid").getBoundingClientRect().height),viewportH:window.innerHeight}));
console.log("HEIGHTS:",JSON.stringify(m));
}finally{await a.b.close();await c.b.close();}})();
