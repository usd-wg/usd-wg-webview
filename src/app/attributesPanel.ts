import type { PrimAttribute } from "../usd/types";
import { runtime } from "./appState";
import { attrList, attrPrimPath, escHtml } from "./dom";
import { applyStageEdit } from "./stageEdits";

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
    const primPath = attrPrimPath.textContent;
    const attrName = input.dataset.attr;
    if (!primPath || !attrName) return;
    const value = input.type === "checkbox" ? String(input.checked) : input.value;
    const changed = runtime.setPrimAttribute(primPath, attrName, value);
    if (!changed) {
      renderAttributes(primPath, runtime.getPrimAttributes(primPath));
      return;
    }
    void applyStageEdit(primPath, "updating attribute...");
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
