#include "webviewCommon.h"

namespace usdwebview {

namespace {

std::string
_PackageRootPathForStage(const UsdStageRefPtr& stage)
{
    std::string packageRootPath = _GetLayerIdentifier(stage->GetRootLayer());
    if (ArIsPackageRelativePath(packageRootPath)) {
        const size_t bracketPos = packageRootPath.find('[');
        if (bracketPos != std::string::npos) {
            packageRootPath = packageRootPath.substr(0, bracketPos);
        }
    }
    return packageRootPath;
}

template <typename T>
bool
_GetAttrValue(const UsdAttribute& attr, T* value)
{
    return attr && attr.Get(value);
}

float
_GetLightFloat(const UsdLuxLightAPI& light, const TfToken& name, float fallback)
{
    float value = fallback;
    _GetAttrValue(light.GetPrim().GetAttribute(name), &value);
    return value;
}

bool
_GetLightBool(const UsdLuxLightAPI& light, const TfToken& name, bool fallback)
{
    bool value = fallback;
    _GetAttrValue(light.GetPrim().GetAttribute(name), &value);
    return value;
}

GfVec3f
_GetLightColor(const UsdLuxLightAPI& light)
{
    GfVec3f color(1.0f, 1.0f, 1.0f);
    _GetAttrValue(light.GetPrim().GetAttribute(TfToken("inputs:color")), &color);
    return color;
}

bool
_IsDomeLightPrim(const UsdPrim& prim)
{
    return static_cast<bool>(UsdLuxDomeLight(prim)) ||
           static_cast<bool>(UsdLuxDomeLight_1(prim));
}

void
_SetCommonLightFields(
    emscripten::val& entry,
    const UsdPrim& prim,
    const UsdLuxLightAPI& light,
    UsdGeomXformCache& xformCache)
{
    const float intensity = _GetLightFloat(light, TfToken("inputs:intensity"), 1.0f);
    const float exposure = _GetLightFloat(light, TfToken("inputs:exposure"), 0.0f);
    const float diffuse = _GetLightFloat(light, TfToken("inputs:diffuse"), 1.0f);
    const float specular = _GetLightFloat(light, TfToken("inputs:specular"), 1.0f);
    const bool normalize = _GetLightBool(light, TfToken("inputs:normalize"), false);
    const bool enableColorTemperature =
        _GetLightBool(light, TfToken("inputs:enableColorTemperature"), false);
    const float colorTemperature =
        _GetLightFloat(light, TfToken("inputs:colorTemperature"), 6500.0f);

    entry.set("path", prim.GetPath().GetString());
    entry.set("name", prim.GetName().GetString());
    entry.set("typeName", prim.GetTypeName().GetString());
    entry.set("matrix", _MatrixArray(xformCache.GetLocalToWorldTransform(prim)));
    entry.set("color", _Vec3Array(_GetLightColor(light)));
    entry.set("intensity", intensity);
    entry.set("exposure", exposure);
    entry.set("effectiveIntensity", intensity * std::pow(2.0f, exposure));
    entry.set("diffuse", diffuse);
    entry.set("specular", specular);
    entry.set("normalize", normalize);
    entry.set("enableColorTemperature", enableColorTemperature);
    entry.set("colorTemperature", colorTemperature);

    UsdLuxShapingAPI shaping(prim);
    if (shaping) {
        float coneAngle = 0.0f;
        float coneSoftness = 0.0f;
        if (shaping.GetShapingConeAngleAttr().Get(&coneAngle)) {
            entry.set("coneAngle", coneAngle);
        }
        if (shaping.GetShapingConeSoftnessAttr().Get(&coneSoftness)) {
            entry.set("coneSoftness", coneSoftness);
        }
    }
}

void
_SetOptionalShadowFields(emscripten::val& entry, const UsdPrim& prim)
{
    UsdLuxShadowAPI shadow(prim);
    if (!shadow) {
        return;
    }

    bool shadowEnable = true;
    if (shadow.GetShadowEnableAttr().Get(&shadowEnable)) {
        entry.set("shadowEnable", shadowEnable);
    }
}

emscripten::val
_UnsupportedLightEntry(
    const UsdPrim& prim,
    const UsdLuxLightAPI& light,
    UsdGeomXformCache& xformCache,
    const std::string& warning)
{
    emscripten::val entry = emscripten::val::object();
    _SetCommonLightFields(entry, prim, light, xformCache);
    _SetOptionalShadowFields(entry, prim);
    entry.set("kind", "unsupported");
    entry.set("supported", false);
    entry.set("warning", warning);
    return entry;
}

} // namespace

emscripten::val
_ExtractStageEnvironment(const UsdStageRefPtr& stage)
{
    if (!stage) {
        return emscripten::val::undefined();
    }

    const std::string packageRootPath = _PackageRootPathForStage(stage);

    for (const UsdPrim& prim : UsdPrimRange(stage->GetPseudoRoot())) {
        if (!_IsDomeLightPrim(prim)) {
            continue;
        }

        SdfAssetPath textureFile;
        if (!_GetAttrValue(prim.GetAttribute(TfToken("inputs:texture:file")), &textureFile)) {
            continue;
        }

        const std::string rawPath = !textureFile.GetResolvedPath().empty()
            ? textureFile.GetResolvedPath()
            : textureFile.GetAssetPath();
        if (rawPath.empty()) {
            continue;
        }

        emscripten::val texture = _ReadTextureAsset(rawPath, packageRootPath);
        if (texture["data"].isUndefined()) {
            continue;
        }

        float intensity = 1.0f;
        _GetAttrValue(prim.GetAttribute(TfToken("inputs:intensity")), &intensity);

        float exposure = 0.0f;
        _GetAttrValue(prim.GetAttribute(TfToken("inputs:exposure")), &exposure);
        const float authoredIntensity = intensity * std::pow(2.0f, exposure);
        float rotation = 0.0f;
        _GetAttrValue(prim.GetAttribute(TfToken("inputs:texture:rotation")), &rotation);

        emscripten::val environment = emscripten::val::object();
        environment.set("sourcePath", prim.GetPath().GetString());
        environment.set("intensity", authoredIntensity);
        environment.set("authoredIntensity", intensity);
        environment.set("authoredExposure", exposure);
        environment.set("viewportCompensation", 1.0f);
        environment.set("rotation", rotation);
        environment.set("texture", texture);
        return environment;
    }

    return emscripten::val::undefined();
}

emscripten::val
_ExtractStageLights(const UsdStageRefPtr& stage, UsdTimeCode timeCode)
{
    emscripten::val lights = emscripten::val::array();
    if (!stage) {
        return lights;
    }

    UsdGeomXformCache xformCache(timeCode);
    size_t index = 0;

    for (const UsdPrim& prim : UsdPrimRange(stage->GetPseudoRoot())) {
        UsdLuxLightAPI light(prim);
        if (!light || _IsDomeLightPrim(prim)) {
            continue;
        }

        emscripten::val entry = emscripten::val::object();
        _SetCommonLightFields(entry, prim, light, xformCache);
        _SetOptionalShadowFields(entry, prim);
        entry.set("supported", true);

        UsdLuxDistantLight distantLight(prim);
        UsdLuxSphereLight sphereLight(prim);
        UsdLuxRectLight rectLight(prim);
        UsdLuxDiskLight diskLight(prim);
        UsdLuxCylinderLight cylinderLight(prim);
        if (distantLight) {
            float angle = 0.53f;
            distantLight.GetAngleAttr().Get(&angle);
            entry.set("kind", "distant");
            entry.set("angle", angle);
        } else if (sphereLight) {
            float radius = 0.5f;
            sphereLight.GetRadiusAttr().Get(&radius);
            bool treatAsPoint = false;
            sphereLight.GetTreatAsPointAttr().Get(&treatAsPoint);
            entry.set("kind", "sphere");
            entry.set("radius", radius);
            entry.set("treatAsPoint", treatAsPoint);
        } else if (rectLight) {
            float width = 1.0f;
            float height = 1.0f;
            rectLight.GetWidthAttr().Get(&width);
            rectLight.GetHeightAttr().Get(&height);
            entry.set("kind", "rect");
            entry.set("width", width);
            entry.set("height", height);
        } else if (diskLight) {
            float radius = 0.5f;
            diskLight.GetRadiusAttr().Get(&radius);
            entry.set("kind", "disk");
            entry.set("radius", radius);
        } else if (cylinderLight) {
            float radius = 0.5f;
            float length = 1.0f;
            cylinderLight.GetRadiusAttr().Get(&radius);
            cylinderLight.GetLengthAttr().Get(&length);
            entry.set("kind", "cylinder");
            entry.set("radius", radius);
            entry.set("length", length);
            entry.set("supported", false);
            entry.set("warning", "UsdLuxCylinderLight has no direct Three.js light equivalent in this viewer.");
        } else if (UsdLuxGeometryLight(prim)) {
            entry = _UnsupportedLightEntry(
                prim, light, xformCache,
                "UsdLuxGeometryLight is not converted; mesh-emissive lighting needs renderer support.");
        } else if (UsdLuxPluginLight(prim)) {
            entry = _UnsupportedLightEntry(
                prim, light, xformCache,
                "UsdLuxPluginLight is renderer-specific and is not converted.");
        } else if (UsdLuxPortalLight(prim)) {
            entry = _UnsupportedLightEntry(
                prim, light, xformCache,
                "UsdLuxPortalLight is a path-tracing guide and is not converted.");
        } else if (prim.HasAPI<UsdLuxMeshLightAPI>()) {
            entry = _UnsupportedLightEntry(
                prim, light, xformCache,
                "UsdLuxMeshLightAPI is not converted; mesh-emissive lighting needs renderer support.");
        } else if (prim.HasAPI<UsdLuxVolumeLightAPI>()) {
            entry = _UnsupportedLightEntry(
                prim, light, xformCache,
                "UsdLuxVolumeLightAPI is not converted; volumetric lighting is unsupported.");
        } else {
            entry = _UnsupportedLightEntry(
                prim, light, xformCache,
                "Unsupported USDLux light type.");
        }

        lights.set(index++, entry);
    }

    return lights;
}

emscripten::val
ExtractStageLights(const std::string& stagePath, double timeCode)
{
    UsdStageRefPtr stage = _GetOrOpenStage(stagePath);
    if (!stage) {
        return emscripten::val::array();
    }
    return _ExtractStageLights(stage, UsdTimeCode(timeCode));
}

} // namespace usdwebview
