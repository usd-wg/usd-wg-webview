// Real browser checks through the dropdown, playbar and composed native stage.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';

const args=process.argv.slice(2);
const option=(name,fallback)=>args.includes(name)?args[args.indexOf(name)+1]:fallback;
const base=option('--base-url','http://127.0.0.1:8002');
const wasms=option('--wasm','32,64').split(',');
const backends=option('--backend','webgl2').split(',');
const output='test-results/cameras';
await mkdir(output,{recursive:true});
const fixtures=new Map(await Promise.all(['scene.usda','rig.usda'].map(async name=>[name,await readFile(new URL(`fixtures/${name}`,import.meta.url),'utf8')])));
fixtures.set('zup.usda',`#usda 1.0
( defaultPrim = "World"
upAxis = "Z" )
def Xform "World" {
 def Camera "Camera" {
  double3 xformOp:translate = (0,-10,0)
  float xformOp:rotateX = 90
  uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:rotateX"]
 }
}`);
const browser=await chromium.launch({headless:true,channel:process.env.USD_WEBVIEW_BROWSER_CHANNEL || (process.platform==='win32'?'msedge':undefined)});
const near=(a,b,label)=>assert(Math.abs(a-b)<1e-5,`${label}: ${a} != ${b}`);
const vector=(a,b,label)=>a.forEach((v,i)=>near(v,b[i],`${label}[${i}]`));
const reports=[];
try {
 for (const wasm of wasms) for(const backend of backends) {
  const page=await browser.newPage({viewport:{width:1000,height:600}});
  page.setDefaultTimeout(60000);
  const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',message=>{ if(message.type()==='error') console.error(message.text()); });
  await page.route('**/__cameras/**',async route=>{
    const name=new URL(route.request().url()).pathname.split('/').at(-1);
    if(name==='manifest.json'||name==='zup.json') {
      const names=name==='zup.json'?['zup.usda']:['scene.usda','rig.usda'];
      await route.fulfill({json:{files:names.map(path=>({path,url:`${base}/__cameras/${path}`}))}});
    } else await route.fulfill({body:fixtures.get(name),contentType:'text/plain'});
  });
  await page.goto(`${base}/?automation=1&wasm=${wasm}${backend==='webgl2'?'&forceWebGL=1':''}`);
  await page.waitForFunction(()=>window.__USD_WEBVIEW_AUTOMATION__);
  const api=async(method,...args)=>page.evaluate(async({method,args})=>window.__USD_WEBVIEW_AUTOMATION__[method](...args),{method,args});
  await api('waitForReady');
  console.log(`[${wasm}/${backend}] application ready`);
  await api('loadManifest',`${base}/__cameras/manifest.json`);
  console.log(`[${wasm}/${backend}] stage loaded`);
  // Automation normally hides controls for the existing visual corpus. This
  // suite explicitly exercises the actual dropdown and playback controls.
  await page.addStyleTag({content:':root.automation-mode .camera-control { display:flex !important; }'});
  await api('settle',25);
  assert.equal((await api('getSplatStats')).backend,backend==='webgpu'?'WebGPU':'WebGL2');
  const paths=await page.locator('#cameraSelect option').evaluateAll(options=>options.map(o=>o.value));
  assert.deepEqual(paths,['/World/Choice/VariantCamera','/World/Instance/Camera','/World/Ortho','/World/Payload/Camera','/World/Rig/Perspective','/World/Rig/Reset','']);
  const editor=await api('getCameraState');
  console.log(`[${wasm}/${backend}] camera list verified`);
  await page.locator('#cameraSelect').selectOption('/World/Rig/Perspective');
  let camera=await api('getCameraState');
  vector(camera.position,[2,3,14],'composed pose');
  vector(camera.quaternion,[0,0,Math.sin(Math.PI/12),Math.cos(Math.PI/12)],'roll without scale');
  near(camera.near,1,'near plane unaffected by authored scale');
  near(camera.projectionMatrix[0],1,'initial focal length');
  near(camera.projectionMatrix[8],0.2,'horizontal lens shift');
  near(camera.projectionMatrix[9],1/6,'vertical lens shift');
  near(camera.gate.width/camera.gate.height,2,'filmback aspect');
  assert.equal(camera.navigationEnabled,false);
  const before=camera;
  await page.mouse.move(400,300); await page.mouse.down(); await page.mouse.move(500,350,{steps:8}); await page.mouse.up();
  await page.mouse.wheel(0,300); await api('settle');
  camera=await api('getCameraState');
  vector(camera.position,before.position,'stage view ignores orbit and zoom');
  await page.locator('[data-navigation-mode="game"]').evaluate(button=>button.click());
  await page.mouse.move(400,300); await page.mouse.down({button:'right'});
  await page.keyboard.down('w'); await page.mouse.move(500,350,{steps:8});
  await api('settle',10); await page.keyboard.up('w'); await page.mouse.up({button:'right'});
  camera=await api('getCameraState');
  vector(camera.position,before.position,'stage view ignores game navigation');
  vector(camera.editorPosition,editor.position,'game navigation preserves saved editor pose');
  await page.locator('[data-navigation-mode="orbital"]').evaluate(button=>button.click());
  assert.equal((await api('getCameraState')).navigationEnabled,false,'mode changes keep stage camera locked');
  await api('setTime',1.5);
  camera=await api('getCameraState');
  vector(camera.position,[3,3,14],'fractional parent animation');
  near(camera.projectionMatrix[0],1.25,'fractional animated focal length');
  await page.locator('#playbarScrubber').fill('3');
  camera=await api('getCameraState');
  vector(camera.position,[6,3,14],'real scrubber');
  near(camera.projectionMatrix[0],2,'animated focal length');
  await api('setTime',1);
  console.log(`[${wasm}/${backend}] scrubbing verified`);
  await page.locator('#playBtn').click();
  await page.waitForFunction(()=>window.__USD_WEBVIEW_AUTOMATION__.getCameraState().position[0]>2.2);
  await page.locator('#playBtn').click();
  assert((await api('getCameraState')).position[0]>2.2,'real playback moves the camera');
  console.log(`[${wasm}/${backend}] playback verified`);
  await page.setViewportSize({width:600,height:1000}); await api('settle');
  camera=await api('getCameraState');
  near(camera.gate.width,600,'portrait gate width'); near(camera.gate.height,300,'portrait gate height');
  await page.locator('#cameraSelect').selectOption(''); await api('settle');
  camera=await api('getCameraState');
  vector(camera.position,editor.position,'editor pose restored'); vector(camera.editorTarget,editor.editorTarget,'editor target restored');
  assert.equal(camera.navigationEnabled,true);
  await page.locator('#cameraSelect').selectOption('/World/Rig/Reset');
  vector((await api('getCameraState')).position,[-5,2,20],'reset transform stack');
  await page.locator('#cameraSelect').selectOption('/World/Instance/Camera');
  vector((await api('getCameraState')).position,[0,0,10],'instance proxy camera');
  await page.locator('#cameraSelect').selectOption('/World/Payload/Camera');
  await api('setPayloadLoaded','/World/Payload',false);
  assert.equal((await api('getCameraState')).path,null,'unloaded camera returns to editor');
  assert.equal(await page.locator('#cameraSelect option[value="/World/Payload/Camera"]').count(),0);
  await api('setPayloadLoaded','/World/Payload',true);
  assert.equal(await page.locator('#cameraSelect option[value="/World/Payload/Camera"]').count(),1);
  await page.locator('#cameraSelect').selectOption('/World/Choice/VariantCamera');
  assert(await api('setVariantSelection','/World/Choice','view','off'));
  assert.equal((await api('getCameraState')).path,null,'removed camera returns to editor');
  await page.setViewportSize({width:1000,height:600});
  await page.locator('#cameraSelect').selectOption('/World/Ortho');
  await api('settle');
  camera=await api('getCameraState');
  assert.equal(camera.projection,'OrthographicCamera');
  near(camera.projectionMatrix[0],0.5,'orthographic world width');
  await api('renderForCapture',1);
  await page.mouse.click(500,300);
  assert.equal(await page.locator('#attrPrimPath').textContent(),'/World/Card','picking uses the active camera');
  const screenshot=await page.locator('.viewport').screenshot({path:`${output}/${wasm}-${backend}.png`});
  const png=PNG.sync.read(screenshot); const center=(Math.floor(png.height/2)*png.width+Math.floor(png.width/2))*4;
  assert(png.data[center]>png.data[center+1]*1.5,'orthographic view actually renders the red card');
  const splat=(Math.floor(png.height/2)*png.width+125)*4;
  assert(png.data[splat+2]>png.data[splat]*1.5,'orthographic view also renders the blue splat');
  await api('loadManifest',`${base}/__cameras/zup.json`);
  assert.equal((await api('getCameraState')).path,null,'new stages start in editor');
  await page.locator('#cameraSelect').selectOption('/World/Camera');
  vector((await api('getCameraState')).position,[0,0,10],'Z-up conversion');
  assert.deepEqual(errors,[]);
  reports.push({wasm,backend,passed:true,cameras:paths.length-1});
  console.log(`Passed stage cameras: WASM${wasm} / ${backend}`);
  await page.close();
 }
} finally {await browser.close(); await writeFile(`${output}/results.json`,JSON.stringify(reports,null,2));}
