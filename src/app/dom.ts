const appElement = document.querySelector<HTMLDivElement>("#app");

if (!appElement) {
  throw new Error("USD Web View root element was not found.");
}

export const app = appElement;

app.innerHTML = `
  <main class="shell" id="shell">
    <nav class="menubar" id="menubar" aria-label="Application menu">
      <div class="menu-item">
        <button class="menu-btn">File</button>
        <ul class="menu-dropdown">
          <li><button class="menu-option" id="menuOpenFile">Open File…</button></li>
          <li><button class="menu-option" id="menuOpenFolder">Open Folder…</button></li>
        </ul>
      </div>
      <div class="menu-item">
        <button class="menu-btn">Edit</button>
        <ul class="menu-dropdown">
          <li><button class="menu-option" disabled>Undo</button></li>
          <li><button class="menu-option" disabled>Redo</button></li>
        </ul>
      </div>
      <div class="menu-item">
        <button class="menu-btn">Settings</button>
        <ul class="menu-dropdown">
          <li class="menu-submenu">
            <button class="menu-option menu-submenu-trigger">Navigation</button>
            <ul class="menu-dropdown menu-submenu-dropdown">
              <li class="menu-submenu">
                <button class="menu-option menu-submenu-trigger">Mode</button>
                <ul class="menu-dropdown menu-submenu-dropdown">
                  <li><button class="menu-option" data-navigation-mode="orbital">Orbital</button></li>
                  <li><button class="menu-option" data-navigation-mode="game">Game Engine</button></li>
                </ul>
              </li>
              <li class="menu-submenu">
                <button class="menu-option menu-submenu-trigger">Camera Speed</button>
                <ul class="menu-dropdown menu-submenu-dropdown">
                  <li><button class="menu-option" data-camera-speed="0.5">0.5x</button></li>
                  <li><button class="menu-option" data-camera-speed="1">1x</button></li>
                  <li><button class="menu-option" data-camera-speed="2">2x</button></li>
                  <li><button class="menu-option" data-camera-speed="5">5x</button></li>
                  <li><button class="menu-option" data-camera-speed="10">10x</button></li>
                </ul>
              </li>
              <li class="menu-submenu">
                <button class="menu-option menu-submenu-trigger">Up Axis</button>
                <ul class="menu-dropdown menu-submenu-dropdown">
                  <li><button class="menu-option" data-up-axis="stage">From Stage</button></li>
                  <li class="menu-separator" role="separator"></li>
                  <li><button class="menu-option" data-up-axis="y">Y Up</button></li>
                  <li><button class="menu-option" data-up-axis="z">Z Up</button></li>
                </ul>
              </li>
            </ul>
          </li>
          <li class="menu-submenu">
            <button class="menu-option menu-submenu-trigger">Display</button>
            <ul class="menu-dropdown menu-submenu-dropdown">
              <li class="menu-submenu">
                <button class="menu-option menu-submenu-trigger">Color Space</button>
                <ul class="menu-dropdown menu-submenu-dropdown">
                  <li><button class="menu-option" data-output-color-space="srgb">sRGB</button></li>
                  <li><button class="menu-option" data-output-color-space="srgb-linear">Linear sRGB</button></li>
                </ul>
              </li>
              <li class="menu-submenu">
                <button class="menu-option menu-submenu-trigger">Tone Mapping</button>
                <ul class="menu-dropdown menu-submenu-dropdown">
                  <li><button class="menu-option" data-tone-mapping="none">None</button></li>
                  <li><button class="menu-option" data-tone-mapping="linear">Linear</button></li>
                  <li><button class="menu-option" data-tone-mapping="reinhard">Reinhard</button></li>
                  <li><button class="menu-option" data-tone-mapping="cineon">Cineon</button></li>
                  <li><button class="menu-option" data-tone-mapping="aces">ACES Filmic</button></li>
                  <li><button class="menu-option" data-tone-mapping="agx">AgX</button></li>
                  <li><button class="menu-option" data-tone-mapping="neutral">Neutral</button></li>
                  <li><button class="menu-option" data-tone-mapping="custom">Custom</button></li>
                </ul>
              </li>
              <li class="menu-meter" id="toneMappingExposureControl">
                <label class="menu-meter-label" for="toneMappingExposureInput">Tone Mapping Exposure <span id="toneMappingExposureValue">1.00</span></label>
                <input id="toneMappingExposureInput" class="menu-meter-input" type="range" min="0" max="5" step="0.01" value="1" />
              </li>
            </ul>
          </li>
          <li class="menu-submenu">
            <button class="menu-option menu-submenu-trigger">Lighting</button>
            <ul class="menu-dropdown menu-submenu-dropdown">
              <li><button class="menu-option" data-lighting-mode="default">Default lighting</button></li>
              <li><button class="menu-option" id="menuLightGizmos">Light gizmos</button></li>
              <li class="menu-submenu">
                <button class="menu-option menu-submenu-trigger">HDR</button>
                <ul class="menu-dropdown menu-submenu-dropdown">
                  <li><button class="menu-option" id="menuLoadHdriMap">Load HDRi map...</button></li>
                  <li><button class="menu-option" id="menuHdriVisible">Visible HDRi</button></li>
                  <li class="menu-meter" id="hdriIntensityControl">
                    <label class="menu-meter-label" for="hdriIntensityInput">IBL intensity <span id="hdriIntensityValue">1.00</span></label>
                    <input id="hdriIntensityInput" class="menu-meter-input" type="range" min="0" max="5" step="0.01" value="1" />
                  </li>
                </ul>
              </li>
            </ul>
          </li>
          <li class="menu-submenu">
            <button class="menu-option menu-submenu-trigger">Rendering</button>
            <ul class="menu-dropdown menu-submenu-dropdown">
              <li class="menu-submenu">
                <button class="menu-option menu-submenu-trigger">Splat Fidelity</button>
                <ul class="menu-dropdown menu-submenu-dropdown">
                  <li><button class="menu-option" data-splat-fidelity="0">Base Color</button></li>
                  <li><button class="menu-option" data-splat-fidelity="1">Low SH</button></li>
                  <li><button class="menu-option" data-splat-fidelity="2">High SH</button></li>
                  <li><button class="menu-option" data-splat-fidelity="3">Full SH</button></li>
                </ul>
              </li>
              <li class="menu-submenu">
                <button class="menu-option menu-submenu-trigger">Splat Detail</button>
                <ul class="menu-dropdown menu-submenu-dropdown">
                  <li><button class="menu-option" data-splat-detail="0">Crisp</button></li>
                  <li><button class="menu-option" data-splat-detail="1">Normal</button></li>
                  <li><button class="menu-option" data-splat-detail="2">Smooth</button></li>
                </ul>
              </li>
              <li class="menu-submenu">
                <button class="menu-option menu-submenu-trigger">Purpose</button>
                <ul class="menu-dropdown menu-submenu-dropdown">
                  <li><button class="menu-option" data-purpose-policy="defaultRender">Default + Render</button></li>
                  <li><button class="menu-option" data-purpose-policy="render">Render</button></li>
                  <li><button class="menu-option" data-purpose-policy="proxy">Proxy</button></li>
                  <li><button class="menu-option" data-purpose-policy="all">All</button></li>
                </ul>
              </li>
              <li><button class="menu-option" id="menuMaterialXFlipV">MaterialX Flip V</button></li>
            </ul>
          </li>
          <li class="menu-submenu">
            <button class="menu-option menu-submenu-trigger">Stage</button>
            <ul class="menu-dropdown menu-submenu-dropdown">
              <li class="menu-submenu">
                <button class="menu-option menu-submenu-trigger">Payloads</button>
                <ul class="menu-dropdown menu-submenu-dropdown">
                  <li><button class="menu-option" id="menuLoadAllPayloads">Load All</button></li>
                  <li><button class="menu-option" id="menuUnloadAllPayloads">Unload All</button></li>
                  <li class="menu-separator" role="separator"></li>
                  <li class="menu-submenu">
                    <button class="menu-option menu-submenu-trigger">Load all payloads on Stage Open</button>
                    <ul class="menu-dropdown menu-submenu-dropdown">
                      <li><button class="menu-option" data-load-payloads-on-open="true">True</button></li>
                      <li><button class="menu-option" data-load-payloads-on-open="false">False</button></li>
                    </ul>
                  </li>
                </ul>
              </li>
            </ul>
          </li>
        </ul>
      </div>
      <div class="menu-item">
        <button class="menu-btn">?</button>
        <ul class="menu-dropdown">
          <li><button class="menu-option" id="menuTutorial">Show Tutorial</button></li>
          <li><button class="menu-option" id="menuStats">Stats</button></li>
        </ul>
      </div>
      <div class="status-bar" id="statusBar" role="status" aria-live="polite">
        <span class="status-spinner" id="statusSpinner" hidden></span>
        <span class="status-mode" id="materialXModeLabel" hidden>Experimental MaterialX / WebGPU</span>
        <span class="status-mode" id="splatDegradationLabel" hidden>Gaussian splats are not rendered with MaterialX content (SparkJS is WebGL-only)</span>
        <span class="status-label" id="statusLabel">Idle</span>
      </div>
      <input id="filePicker" type="file" multiple accept=".usd,.usda,.usdc,.usdz,.mtlx,.zip,.png,.jpg,.jpeg,.webp,.svg,.exr" style="display:none" />
      <input id="folderPicker" type="file" webkitdirectory style="display:none" />
      <input id="hdriPicker" type="file" accept=".hdr,.exr" style="display:none" />
    </nav>
    <nav class="scene-graph" aria-label="Scene graph">
      <div class="panel-header">Scene Graph</div>
      <ol id="sceneGraphList" class="sg-list"></ol>
      <div class="sg-resize-x" id="sgResizeX"></div>
    </nav>
    <section class="viewport" aria-label="USD Web View viewport">
      <div class="playbar" id="playbar" hidden>
        <button class="playbar-btn" id="playBtn" aria-label="Play">&#9654;</button>
        <span class="playbar-time" id="playbarTime">0</span>
        <div class="playbar-track-wrap">
          <input class="playbar-scrubber" id="playbarScrubber" type="range" min="0" max="100" value="0" step="1" />
        </div>
        <span class="playbar-end" id="playbarEnd">0</span>
      </div>
    </section>
    <div class="attr-panel" id="attrPanel">
      <div class="attr-resize-y" id="attrResizeY"></div>
      <div class="panel-header">
        <span>Attributes</span>
        <span id="attrPrimPath" class="attr-prim-path"></span>
      </div>
      <div id="attrList" class="attr-list">
        <p class="sg-empty">Select a prim to inspect</p>
      </div>
    </div>
  </main>
  <div class="stats-panel" id="statsPanel" hidden>
    <div class="stats-header">
      <span>Stats</span>
      <button class="stats-close" id="statsClose" aria-label="Close">&times;</button>
    </div>
    <div class="stats-body">
      <p class="stats-section-title">USD Stage</p>
      <dl id="usdStageSummary" class="status-list"></dl>
      <p class="stats-section-title">Renderer</p>
      <dl id="rendererSummary" class="status-list"></dl>
    </div>
  </div>
  <div class="tutorial-overlay" id="tutorialOverlay" hidden>
    <div class="tutorial-modal">
      <div class="tutorial-header">
        <span>Controls</span>
        <button class="tutorial-close" id="tutorialClose" aria-label="Close">&times;</button>
      </div>
      <table class="tutorial-table">
        <thead><tr><th colspan="2">Viewport</th></tr></thead>
        <tbody>
          <tr><td>Left drag</td><td>Orbit camera</td></tr>
          <tr><td>Right drag / Two-finger</td><td>Pan camera</td></tr>
          <tr><td>Scroll / Pinch</td><td>Zoom camera</td></tr>
          <tr><td>F</td><td>Frame selected prim</td></tr>
          <tr><td>Click mesh</td><td>Select prim</td></tr>
          <tr><td>Settings &gt; Navigation &gt; Mode &gt; Game Engine</td><td>Hold right mouse and use WASD + Q/E to fly; scroll while held changes speed</td></tr>
        </tbody>
        <thead><tr><th colspan="2">Scene Graph</th></tr></thead>
        <tbody>
          <tr><td>Click item</td><td>Select &amp; highlight prim</td></tr>
          <tr><td>Drop USD / folder</td><td>Load stage</td></tr>
          <tr><td><span class="sg-badge sg-badge--variant" style="pointer-events:none">V</span> badge</td><td>Prim has USD variant sets — click to cycle, dropdown to pick</td></tr>
          <tr><td><span class="sg-badge sg-badge--payload sg-badge--payload-loaded" style="pointer-events:none">P</span> badge (amber)</td><td>Payload loaded — click to unload; prim stays in tree but dims</td></tr>
          <tr><td><span class="sg-badge sg-badge--payload" style="pointer-events:none">P</span> badge (grey)</td><td>Payload unloaded — click to reload geometry and materials</td></tr>
          <tr><td>Settings &gt; Stage &gt; Payloads</td><td>Bulk-toggle payloads and choose the stage-open payload policy</td></tr>
        </tbody>
      </table>
    </div>
  </div>
`;

function requireElement<T extends Element>(element: T | null): T {
  if (!element) {
    throw new Error("USD Web View UI failed to initialize.");
  }
  return element;
}

export const viewportElement = requireElement(app.querySelector<HTMLElement>(".viewport"));
export const usdStageSummaryList = requireElement(app.querySelector<HTMLElement>("#usdStageSummary"));
export const rendererSummaryList = requireElement(app.querySelector<HTMLElement>("#rendererSummary"));
export const filePicker = requireElement(app.querySelector<HTMLInputElement>("#filePicker"));
export const folderPicker = requireElement(app.querySelector<HTMLInputElement>("#folderPicker"));
export const hdriPicker = requireElement(app.querySelector<HTMLInputElement>("#hdriPicker"));
export const playbar = requireElement(app.querySelector<HTMLElement>("#playbar"));
export const playBtn = requireElement(app.querySelector<HTMLButtonElement>("#playBtn"));
export const playbarTime = requireElement(app.querySelector<HTMLElement>("#playbarTime"));
export const playbarEnd = requireElement(app.querySelector<HTMLElement>("#playbarEnd"));
export const playbarScrubber = requireElement(app.querySelector<HTMLInputElement>("#playbarScrubber"));
export const statusSpinner = requireElement(app.querySelector<HTMLElement>("#statusSpinner"));
export const statusLabel = requireElement(app.querySelector<HTMLElement>("#statusLabel"));
export const materialXModeLabel = requireElement(app.querySelector<HTMLElement>("#materialXModeLabel"));
export const splatDegradationLabel = requireElement(app.querySelector<HTMLElement>("#splatDegradationLabel"));
export const sceneGraphList = requireElement(app.querySelector<HTMLElement>("#sceneGraphList"));
export const attrPrimPath = requireElement(app.querySelector<HTMLElement>("#attrPrimPath"));
export const attrList = requireElement(app.querySelector<HTMLElement>("#attrList"));
export const statsPanel = requireElement(app.querySelector<HTMLElement>("#statsPanel"));
export const statsClose = requireElement(app.querySelector<HTMLButtonElement>("#statsClose"));
export const tutorialOverlay = requireElement(app.querySelector<HTMLElement>("#tutorialOverlay"));
export const tutorialClose = requireElement(app.querySelector<HTMLButtonElement>("#tutorialClose"));
export const hdriIntensityInput = requireElement(app.querySelector<HTMLInputElement>("#hdriIntensityInput"));
export const hdriIntensityValue = requireElement(app.querySelector<HTMLElement>("#hdriIntensityValue"));
export const toneMappingExposureInput = requireElement(app.querySelector<HTMLInputElement>("#toneMappingExposureInput"));
export const toneMappingExposureValue = requireElement(app.querySelector<HTMLElement>("#toneMappingExposureValue"));

export function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
