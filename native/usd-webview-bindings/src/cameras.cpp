#include "webviewCommon.h"
#include "pxr/base/gf/camera.h"
#include "pxr/base/gf/frustum.h"
#include "pxr/usd/usdGeom/camera.h"

namespace usdwebview {

emscripten::val
GetStageCameras(const std::string& path)
{
    auto result = emscripten::val::array();
    const auto stage = _GetOrOpenStage(path);
    if (!stage) return result;
    size_t index = 0;
    // Include instance proxies: cameras may live inside referenced camera rigs.
    for (const auto& prim : UsdPrimRange(stage->GetPseudoRoot(), UsdTraverseInstanceProxies())) {
        if (!prim.IsA<UsdGeomCamera>()) continue;
        auto entry = emscripten::val::object();
        entry.set("path", prim.GetPath().GetString());
        entry.set("name", prim.GetName().GetString());
        result.set(index++, entry);
    }
    return result;
}

emscripten::val
SampleStageCamera(const std::string& path, const std::string& cameraPath, double timeCode)
{
    const auto stage = _GetOrOpenStage(path);
    if (!stage || !std::isfinite(timeCode)) return emscripten::val::null();
    const auto prim = stage->GetPrimAtPath(SdfPath(cameraPath));
    if (!prim || !prim.IsActive() || !prim.IsLoaded() || !prim.IsDefined()) {
        return emscripten::val::null();
    }
    const UsdGeomCamera usdCamera(prim);
    if (!usdCamera) return emscripten::val::null();
    // GetCamera resolves references, parent animation, resetXformStack and lens
    // samples at the same USD time. GfFrustum removes camera scale/shear using
    // OpenUSD's own orthonormalization (ALab cameras contain a scale of 100).
    const GfCamera camera = usdCamera.GetCamera(UsdTimeCode(timeCode));
    const GfFrustum frustum = camera.GetFrustum();
    auto result = emscripten::val::object();
    result.set("path", cameraPath);
    result.set("matrix", _MatrixArray(frustum.ComputeViewInverse()));
    result.set("projection", camera.GetProjection() == GfCamera::Orthographic
        ? std::string("orthographic") : std::string("perspective"));
    result.set("horizontalAperture", camera.GetHorizontalAperture());
    result.set("verticalAperture", camera.GetVerticalAperture());
    result.set("horizontalApertureOffset", camera.GetHorizontalApertureOffset());
    result.set("verticalApertureOffset", camera.GetVerticalApertureOffset());
    result.set("focalLength", camera.GetFocalLength());
    result.set("near", camera.GetClippingRange().GetMin());
    result.set("far", camera.GetClippingRange().GetMax());
    return result;
}

} // namespace usdwebview
