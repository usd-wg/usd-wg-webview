import type { PrimAttribute } from "../usd/types";
import { runtime } from "./appState";
import { attrList, attrPrimPath, escHtml } from "./dom";
import { applyLightAttributeEdit, applyStageEdit } from "./stageEdits";

let liveAttributeUpdateTimer: number | null = null;

export function renderAttributes(primPath: string, attrs: PrimAttribute[]): void {
  attrPrimPath.textContent = primPath;
  attrList.innerHTML = attrs.length
    ? attrs.map((a) => {
        if (a.typeName === "variantSet" && a.variantOptions) {
          const opts = a.variantOptions
            .map((o) => `<option value="${escHtml(o)}"${o === a.value ? " selected" : ""}>${escHtml(o)}</option>`)
            .join("");
          return (
            `<div class="attr-row attr-authored">` +
            `<span class="attr-name">${escHtml(a.name)}</span>` +
            `<span class="attr-type">variantSet</span>` +
            `<select class="attr-variant-select" data-primpath="${escHtml(primPath)}" data-variantset="${escHtml(a.name)}">${opts}</select>` +
            `</div>`
          );
        }
        return (
          `<div class="attr-row${a.isAuthored ? " attr-authored" : ""}">` +
          `<span class="attr-name">${escHtml(a.name)}</span>` +
          `<span class="attr-type">${escHtml(a.typeName)}</span>` +
          renderAttributeValue(a) +
          `</div>`
        );
      }).join("")
    : '<p class="sg-empty">No attributes</p>';
}

function renderAttributeValue(attr: PrimAttribute): string {
  const value = attr.value ?? "—";
  if (attr.editable && attr.typeName === "color3f") {
    const color = parseColor3f(value);
    const hex = color ? color3fToHex(color) : "#ffffff";
    const text = color ? color.map((component) => formatFloat(component)).join(" ") : value;
    return (
      `<span class="attr-color-edit">` +
      `<input class="attr-edit attr-edit-color" type="color" data-attr="${escHtml(attr.name)}" value="${hex}" />` +
      `<input class="attr-edit attr-edit-color-text" type="text" data-attr="${escHtml(attr.name)}" value="${escHtml(text)}" />` +
      `</span>`
    );
  }
  if (attr.editable && !attr.valueIsArray) {
    if (attr.typeName === "bool") {
      const checked = value === "1" || value === "true" ? " checked" : "";
      return `<input class="attr-edit attr-edit-bool" type="checkbox" data-attr="${escHtml(attr.name)}"${checked} />`;
    }
    const inputType = attr.typeName === "float" || attr.typeName === "double" || attr.typeName === "int"
      ? "number"
      : "text";
    const step = attr.typeName === "int" ? "1" : "any";
    return `<input class="attr-edit" type="${inputType}" step="${step}" data-attr="${escHtml(attr.name)}" value="${escHtml(value)}" />`;
  }
  if (!attr.valueIsArray) {
    return `<span class="attr-value">${escHtml(value)}</span>`;
  }

  const count = attr.valueElementCount ?? 0;
  return (
    `<div class="attr-value attr-value-array-shell" title="${escHtml(String(count))} elements">` +
    `<button class="attr-array-scroll" type="button" data-array-scroll="-1" aria-label="Scroll attribute values left">‹</button>` +
    `<div class="attr-value-array" tabindex="0">` +
    `<span class="attr-array-count">${count} elements</span>` +
    `<span class="attr-array-items">${escHtml(value)}</span>` +
    `</div>` +
    `<button class="attr-array-scroll" type="button" data-array-scroll="1" aria-label="Scroll attribute values right">›</button>` +
    `</div>`
  );
}

attrList.addEventListener("change", (e) => {
  const input = (e.target as Element).closest<HTMLInputElement>(".attr-edit");
  if (input) {
    commitLightAttributeInput(input, true);
    return;
  }

  const select = (e.target as Element).closest<HTMLSelectElement>(".attr-variant-select");
  if (!select) return;
  const changed = runtime.setVariantSelection(select.dataset.primpath!, select.dataset.variantset!, select.value);
  if (!changed) {
    renderAttributes(select.dataset.primpath!, runtime.getPrimAttributes(select.dataset.primpath!));
    return;
  }
  void applyStageEdit(select.dataset.primpath, "loading variant...");
});

attrList.addEventListener("input", (e) => {
  const colorInput = (e.target as Element).closest<HTMLInputElement>(".attr-edit-color");
  if (colorInput) {
    const textInput = colorInput.parentElement?.querySelector<HTMLInputElement>(".attr-edit-color-text");
    if (textInput) {
      textInput.value = hexToColor3f(colorInput.value);
    }
    scheduleLiveLightAttributeInput(colorInput);
    return;
  }

  const numberInput = (e.target as Element).closest<HTMLInputElement>(".attr-edit[type='number']");
  if (numberInput) {
    scheduleLiveLightAttributeInput(numberInput);
  }
});

attrList.addEventListener("click", (e) => {
  const button = (e.target as Element).closest<HTMLButtonElement>("[data-array-scroll]");
  if (!button) return;
  const scroller = button.parentElement?.querySelector<HTMLElement>(".attr-value-array");
  if (!scroller) return;
  const direction = Number(button.dataset.arrayScroll) || 1;
  scroller.scrollBy({
    left: direction * Math.max(160, Math.floor(scroller.clientWidth * 0.75)),
    behavior: "smooth",
  });
});

function parseColor3f(value: string): [number, number, number] | null {
  const numbers = value.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi)?.map(Number) ?? [];
  if (numbers.length < 3 || numbers.slice(0, 3).some((number) => !Number.isFinite(number))) {
    return null;
  }
  return [numbers[0], numbers[1], numbers[2]];
}

function scheduleLiveLightAttributeInput(input: HTMLInputElement): void {
  if (liveAttributeUpdateTimer !== null) {
    window.clearTimeout(liveAttributeUpdateTimer);
  }
  liveAttributeUpdateTimer = window.setTimeout(() => {
    liveAttributeUpdateTimer = null;
    commitLightAttributeInput(input, false);
  }, 120);
}

function commitLightAttributeInput(input: HTMLInputElement, refreshAttributes: boolean): void {
  const primPath = attrPrimPath.textContent;
  const attrName = input.dataset.attr;
  if (!primPath || !attrName || !input.reportValidity()) return;
  const value = input.type === "checkbox"
    ? String(input.checked)
    : input.type === "color"
    ? hexToColor3f(input.value)
    : input.value;
  const changed = runtime.setPrimAttribute(primPath, attrName, value);
  if (!changed) {
    if (refreshAttributes) {
      renderAttributes(primPath, runtime.getPrimAttributes(primPath));
    }
    return;
  }
  if (attrName === "inputs:colorTemperature") {
    runtime.setPrimAttribute(primPath, "inputs:enableColorTemperature", "true");
  }
  void applyLightAttributeEdit(refreshAttributes);
}

function color3fToHex(color: [number, number, number]): string {
  return `#${color.map((component) =>
    Math.round(clamp01(component) * 255).toString(16).padStart(2, "0")
  ).join("")}`;
}

function hexToColor3f(hex: string): string {
  const value = hex.replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(value)) {
    return "1 1 1";
  }
  const r = parseInt(value.slice(0, 2), 16) / 255;
  const g = parseInt(value.slice(2, 4), 16) / 255;
  const b = parseInt(value.slice(4, 6), 16) / 255;
  return [r, g, b].map(formatFloat).join(" ");
}

function formatFloat(value: number): string {
  return Number(value.toFixed(6)).toString();
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}
