#include "webviewCommon.h"

#include <emscripten/bind.h>
#include <emscripten/heap.h>
#include <malloc.h>

using namespace usdwebview;

static emscripten::val GetMemoryStats()
{
    const auto info = mallinfo();
    auto result = emscripten::val::object();
    // JS Numbers preserve these byte counts exactly; do not narrow size_t to
    // a 32-bit integer or expose a WASM64-only BigInt API.
    result.set("capacityBytes", double(emscripten_get_heap_size()));
    result.set("maximumBytes", double(emscripten_get_heap_max()));
    result.set("allocatedBytes", double(info.uordblks));
    result.set("allocatorFreeBytes", double(info.fordblks));
    return result;
}

// SPIKE (Phase 3 entry gates S1-S3) — removed when WebViewStageDriver lands.
EMSCRIPTEN_BINDINGS(usdWebViewBindings)
{
    emscripten::function("InitializeRuntime", &InitializeRuntime);
    emscripten::function("GetMemoryStats", &GetMemoryStats);
    emscripten::function("CloseStage", &CloseStage);
    emscripten::function("CreateStageDriver", &CreateStageDriver);
    emscripten::function("DeleteStageDriver", &DeleteStageDriver);
    emscripten::function("StageDriverSetTime", &StageDriverSetTime);
    emscripten::function("StageDriverDraw", &StageDriverDraw);
    emscripten::function("StageDriverDrawSubtree", &StageDriverDrawSubtree);
    emscripten::function("StageDriverGetTiming", &StageDriverGetTiming);
    emscripten::function("StageDriverGetCapabilities", &StageDriverGetCapabilities);
    emscripten::function("StageDriverGetDiagnostics", &StageDriverGetDiagnostics);
    emscripten::function("StageDriverNotifyStageEdited", &StageDriverNotifyStageEdited);
    emscripten::function("ExtractMaterialPayloads", &ExtractMaterialPayloads);
    emscripten::function("GetRuntimeDiagnostics", &GetRuntimeDiagnostics);
    emscripten::function("GetLastSkelBindingOverlayContents", &GetLastSkelBindingOverlayContents);
    emscripten::function("InspectPrimRelationships", &InspectPrimRelationships);
    emscripten::function("GetSkelDebugInfo", &GetSkelDebugInfo);
    emscripten::function("ExtractTransformsAtTime", &ExtractTransformsAtTime);
    emscripten::function("OpenStage", &OpenStage);
    emscripten::function("GetSceneGraph", &GetSceneGraph);
    emscripten::function("GetPrimAttributes", &GetPrimAttributes);
    emscripten::function("SetPrimAttribute", &SetPrimAttribute);
    emscripten::function("ExtractStageEnvironment", &ExtractStageEnvironment);
    emscripten::function("ExtractStageLights", &ExtractStageLights);
    emscripten::function("ReopenStage", &ReopenStage);
    emscripten::function("SetVariantSelection", &SetVariantSelection);
    emscripten::function("SetPayloadLoaded", &SetPayloadLoaded);
    emscripten::function("SetAllPayloadsLoaded", &SetAllPayloadsLoaded);
    emscripten::function("ExtractGaussianSplats", &ExtractGaussianSplats);
}
