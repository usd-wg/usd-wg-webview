const _wasmBuildId = "wasm-cb523350586e"; // stamped by tools/native-build/stamp-build.mjs
const _wrapperBuildId = "wasm-cb523350586e";

function normalizePath(path) {
  return `/${String(path).replace(/^\/+/, "")}`;
}

function dirname(path) {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "/" : normalized.slice(0, index);
}

function basename(path) {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  return normalized.slice(index + 1);
}

function ensureDirectory(module, path) {
  const normalized = normalizePath(path);
  if (normalized === "/") {
    return;
  }

  let current = "";
  for (const part of normalized.split("/").filter(Boolean)) {
    current += `/${part}`;
    if (!module.FS_analyzePath(current).exists) {
      module.FS_createPath(dirname(current), basename(current), true, true);
    }
  }
}

window.UsdWebViewBindings = {
  async createRuntime(options = {}) {
    const { default: createUsdWebViewBindingsModule } =
      await import(`./usdWebViewBindingsModule.js?v=${_wasmBuildId}`);
    const module = await createUsdWebViewBindingsModule({
      locateFile(path) {
        const base = options.locateFile?.(path) ?? path;
        return path.endsWith(".wasm") ? `${base}?v=${_wasmBuildId}` : base;
      },
    });

    module.InitializeRuntime();

    // Debug/automation hook: raw module access for console A/B comparisons
    // and refactor spikes. Not part of the supported API surface.
    window.__USD_WEBVIEW_MODULE__ = module;

    // Stores the original immutable bytes for each file, keyed by normalized path.
    const _originalLayerData = new Map();
    // Tracks current variant selections per stage.
    // Key: normalized stage path → Map of "primPath::vsName" → selection string.
    const _variantSelections = new Map();

    // Replace the value of `string vsName = "..."` inside the variants = { }
    // metadata block of the named prim. Uses the prim's last path component as
    // an anchor so same-named variant sets on different prims don't collide.
    function _replaceVariantInText(text, primPath, vsName, selection) {
      const primName = primPath.split("/").filter(Boolean).pop();
      if (!primName) return text;

      // Find the prim definition header: "PrimName" (
      // We search from the start so the first match in the hierarchy wins,
      // which is correct since prim names are unique within their parent scope.
      const headerIdx = text.indexOf(`"${primName}" (`);
      if (headerIdx < 0) return text;

      // Find the opening ( of the metadata block
      const metaOpen = text.indexOf("(", headerIdx);
      if (metaOpen < 0) return text;

      // Find the closing ) of the metadata block (scan for balanced parens)
      let depth = 1;
      let metaClose = metaOpen + 1;
      while (metaClose < text.length && depth > 0) {
        if (text[metaClose] === "(") depth++;
        else if (text[metaClose] === ")") depth--;
        metaClose++;
      }

      // Find variants = { within the metadata block
      const variantsOpen = text.indexOf("variants = {", metaOpen);
      if (variantsOpen < 0 || variantsOpen >= metaClose) return text;

      const variantsClose = text.indexOf("}", variantsOpen);
      if (variantsClose < 0 || variantsClose >= metaClose) return text;

      // Replace the specific variant selection only inside that block
      const findKey = `string ${vsName} = "`;
      const keyIdx = text.indexOf(findKey, variantsOpen);
      if (keyIdx < 0 || keyIdx >= variantsClose) return text;

      const valStart = keyIdx + findKey.length;
      const valEnd = text.indexOf('"', valStart);
      if (valEnd < 0 || valEnd >= variantsClose) return text;

      return text.slice(0, valStart) + selection + text.slice(valEnd);
    }

    function writeToVfs(filePath, data) {
      ensureDirectory(module, dirname(filePath));
      if (module.FS_analyzePath(filePath).exists) {
        module.FS_unlink(filePath);
      }
      module.FS_createDataFile(
        dirname(filePath),
        basename(filePath),
        data,
        true,
        true,
        true
      );
    }

    return {
      ready: Promise.resolve(),
      createDataFile(path, data) {
        const filePath = normalizePath(path);
        if (!_originalLayerData.has(filePath)) {
          _originalLayerData.set(filePath, data.slice());
        }
        writeToVfs(filePath, data);
      },
      closeStage(path) {
        if (module.CloseStage) {
          module.CloseStage(normalizePath(path));
        }
        // Stage loads are whole-world replacements, so every tracked data
        // file belongs to the outgoing stage: unlink them all from MEMFS.
        for (const filePath of _originalLayerData.keys()) {
          if (module.FS_analyzePath(filePath).exists) {
            module.FS_unlink(filePath);
          }
        }
        _originalLayerData.clear();
      },
      createStageDriver(path) {
        return module.CreateStageDriver
          ? module.CreateStageDriver(normalizePath(path))
          : false;
      },
      deleteStageDriver(path) {
        if (module.DeleteStageDriver) {
          module.DeleteStageDriver(normalizePath(path));
        }
      },
      stageDriverSetTime(path, timeCode) {
        module.StageDriverSetTime(normalizePath(path), timeCode);
      },
      stageDriverDraw(path, full, purposePolicy = "defaultRender") {
        return module.StageDriverDraw(normalizePath(path), full, purposePolicy);
      },
      stageDriverDrawSubtree(path, primPath, purposePolicy = "defaultRender") {
        return module.StageDriverDrawSubtree(normalizePath(path), primPath, purposePolicy);
      },
      stageDriverGetTiming(path) {
        return module.StageDriverGetTiming(normalizePath(path));
      },
      stageDriverGetCapabilities(path) {
        return module.StageDriverGetCapabilities(normalizePath(path));
      },
      stageDriverGetDiagnostics(path) {
        return module.StageDriverGetDiagnostics(normalizePath(path));
      },
      stageDriverNotifyStageEdited(path) {
        module.StageDriverNotifyStageEdited(normalizePath(path));
      },
      extractMaterialPayloads(path) {
        return module.ExtractMaterialPayloads(normalizePath(path));
      },
      extractGaussianSplats(path) {
        return module.ExtractGaussianSplats(normalizePath(path));
      },
      extractTransformsAtTime(path, timeCode) {
        return module.ExtractTransformsAtTime(normalizePath(path), timeCode);
      },
      openStage(path, loadAllPayloads = true) {
        return module.OpenStage(normalizePath(path), loadAllPayloads);
      },
      inspectPrimRelationships(stagePath, primPath) {
        return module.InspectPrimRelationships(normalizePath(stagePath), primPath);
      },
      getLastSkelBindingOverlayContents(stagePath) {
        return module.GetLastSkelBindingOverlayContents(normalizePath(stagePath));
      },
      getSkelDebugInfo(stagePath, primPath, timeA = 0, timeB = 60) {
        return module.GetSkelDebugInfo(normalizePath(stagePath), primPath, timeA, timeB);
      },
      getSceneGraph(path) {
        return module.GetSceneGraph(normalizePath(path));
      },
      getPrimAttributes(stagePath, primPath) {
        return module.GetPrimAttributes(normalizePath(stagePath), primPath);
      },
      setPrimAttribute(stagePath, primPath, attrName, value) {
        return module.SetPrimAttribute(normalizePath(stagePath), primPath, attrName, value);
      },
      extractStageEnvironment(stagePath) {
        return module.ExtractStageEnvironment(normalizePath(stagePath));
      },
      extractStageLights(stagePath, timeCode = 0) {
        return module.ExtractStageLights(normalizePath(stagePath), timeCode);
      },
      setPayloadLoaded(stagePath, primPath, loaded) {
        return module.SetPayloadLoaded(normalizePath(stagePath), primPath, loaded);
      },
      setAllPayloadsLoaded(stagePath, loaded) {
        return module.SetAllPayloadsLoaded(normalizePath(stagePath), loaded);
      },
      setVariantSelection(stagePath, primPath, variantSetName, selection) {
        const normalized = normalizePath(stagePath);

        if (module.SetVariantSelection) {
          const changed = module.SetVariantSelection(
            normalized,
            primPath,
            variantSetName,
            selection
          );
          if (changed) {
            return true;
          }
          console.warn(
            `[USD WebView] native variant selection failed for ${primPath} ${variantSetName}=${selection}; falling back to root-layer edit`
          );
        }

        if (!_variantSelections.has(normalized)) {
          _variantSelections.set(normalized, new Map());
        }
        _variantSelections.get(normalized).set(`${primPath}::${variantSetName}`, { primPath, variantSetName, selection });

        const originalBytes = _originalLayerData.get(normalized);
        if (!originalBytes) return false;

        let text = new TextDecoder().decode(originalBytes);

        for (const { primPath: pp, variantSetName: vsName, selection: sel } of _variantSelections.get(normalized).values()) {
          text = _replaceVariantInText(text, pp, vsName, sel);
        }

        writeToVfs(normalized, new TextEncoder().encode(text));
        return module.ReopenStage(normalized);
      },
    };
  },
};
