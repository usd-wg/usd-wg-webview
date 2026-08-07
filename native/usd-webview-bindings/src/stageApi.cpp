#include "webviewCommon.h"

namespace usdwebview {

int
_CountPrims(const UsdStageRefPtr& stage)
{
    int count = 0;
    for (const UsdPrim& prim : UsdPrimRange(stage->GetPseudoRoot())) {
        if (!prim.IsPseudoRoot()) {
            ++count;
        }
    }
    return count;
}

struct StageAuthoredStats
{
    int meshPrimCount = 0;
    int authoredPointCount = 0;
    int authoredFaceCount = 0;
    int materialPrimCount = 0;
    int materialBindingCount = 0;
    int textureAssetCount = 0;
    int payloadPrimCount = 0;
    int variantSetCount = 0;
    int instancePrimCount = 0;
};

StageAuthoredStats
_CollectStageAuthoredStats(const UsdStageRefPtr& stage)
{
    StageAuthoredStats stats;
    std::unordered_set<std::string> textureAssetPaths;

    for (const UsdPrim& prim : UsdPrimRange(stage->GetPseudoRoot())) {
        if (prim.IsPseudoRoot()) {
            continue;
        }

        if (prim.HasAuthoredPayloads()) {
            ++stats.payloadPrimCount;
        }
        if (prim.IsInstance()) {
            ++stats.instancePrimCount;
        }

        std::vector<std::string> variantSetNames;
        prim.GetVariantSets().GetNames(&variantSetNames);
        stats.variantSetCount += static_cast<int>(variantSetNames.size());

        if (prim.HasRelationship(TfToken("material:binding"))) {
            ++stats.materialBindingCount;
        }

        if (prim.IsA<UsdShadeMaterial>()) {
            ++stats.materialPrimCount;
        }

        if (prim.IsA<UsdShadeShader>()) {
            UsdShadeShader shader(prim);
            SdfAssetPath filePath;
            UsdShadeInput fileInput = shader.GetInput(TfToken("file"));
            if (fileInput && fileInput.Get(&filePath)) {
                const std::string path = !filePath.GetResolvedPath().empty()
                    ? filePath.GetResolvedPath()
                    : filePath.GetAssetPath();
                if (!path.empty()) {
                    textureAssetPaths.insert(path);
                }
            }
        }

        if (prim.IsA<UsdGeomMesh>()) {
            ++stats.meshPrimCount;
            UsdGeomMesh mesh(prim);

            VtArray<GfVec3f> points;
            if (mesh.GetPointsAttr().Get(&points)) {
                stats.authoredPointCount += static_cast<int>(points.size());
            }

            VtArray<int> faceVertexCounts;
            if (mesh.GetFaceVertexCountsAttr().Get(&faceVertexCounts)) {
                stats.authoredFaceCount += static_cast<int>(faceVertexCounts.size());
            }
        }
    }

    stats.textureAssetCount = static_cast<int>(textureAssetPaths.size());
    return stats;
}

void
_ForceUsdSkelImagingStaticRegistration()
{
    // In a static WASM link, plugInfo can advertise adapter types whose object
    // files were otherwise not pulled from libusd_usdSkelImaging.a. Touch the
    // concrete adapter classes so their TF_REGISTRY_FUNCTION blocks are linked
    // and the plugin system can manufacture them at runtime.
    static const bool registered = []() {
        UsdSkelImagingAnimationAdapter animationAdapter;
        UsdSkelImagingBindingAPIAdapter bindingAdapter;
        UsdSkelImagingBlendShapeAdapter blendShapeAdapter;
        UsdSkelImagingResolvingSceneIndexPlugin resolvingSceneIndexPlugin;
        UsdSkelImagingSkeletonAdapter skeletonAdapter;
        UsdSkelImagingSkelRootAdapter skelRootAdapter;

        (void)animationAdapter;
        (void)bindingAdapter;
        (void)blendShapeAdapter;
        (void)resolvingSceneIndexPlugin;
        (void)skeletonAdapter;
        (void)skelRootAdapter;
        return true;
    }();
    (void)registered;
}

void
InitializeRuntime()
{
    static std::atomic<bool> initialized{false};
    if (initialized.exchange(true)) {
        return;
    }

    _ForceUsdSkelImagingStaticRegistration();
    TfType::Define<GfHalf>();
    PlugRegistry::GetInstance().RegisterPlugins("/usd");

    const TfType resolverType = TfType::FindByName("Sdf_UsdzResolver");
    if (resolverType.IsUnknown() ||
        !resolverType.GetFactory<Ar_PackageResolverFactoryBase>()) {
        Ar_DefinePackageResolver<Sdf_UsdzResolver, ArPackageResolver>();
    }

    if (!SdfFileFormat::FindById(TfToken("usdz"))) {
        SdfDefineFileFormat<SdfUsdzFileFormat, SdfFileFormat>();
    }
}

emscripten::val
GetRuntimeDiagnostics()
{
    emscripten::val result = emscripten::val::object();
    const TfType resolverType = TfType::FindByName("Sdf_UsdzResolver");
    result.set("hasUsdzResolverType", !resolverType.IsUnknown());
    result.set(
        "hasUsdzResolverFactory",
        resolverType.GetFactory<Ar_PackageResolverFactoryBase>() != nullptr);
    result.set("canReadUsdz", SdfFileFormat::FormatSupportsReading("usdz", "usd"));
    result.set("hasUsdzFormat", static_cast<bool>(SdfFileFormat::FindByExtension("file.usdz", "usd")));
    result.set("hasUsdzFormatNoTarget", static_cast<bool>(SdfFileFormat::FindByExtension("file.usdz")));
    result.set("hasUsdzFormatById", static_cast<bool>(SdfFileFormat::FindById(TfToken("usdz"))));
    return result;
}

std::string
GetLastSkelBindingOverlayContents(const std::string& stagePath)
{
    auto it = g_stageRegistry.find(stagePath);
    return it == g_stageRegistry.end()
        ? std::string()
        : it->second.lastSkelBindingOverlayContents;
}

emscripten::val
InspectPrimRelationships(const std::string& stagePath, const std::string& primPath)
{
    emscripten::val result = emscripten::val::array();
    UsdStageRefPtr stage = _GetOrOpenStage(stagePath);
    if (!stage) {
        return result;
    }

    UsdPrim prim = stage->GetPrimAtPath(SdfPath(primPath));
    size_t index = 0;
    for (UsdPrim bindingPrim = prim; bindingPrim && !bindingPrim.IsPseudoRoot();
         bindingPrim = bindingPrim.GetParent()) {
        emscripten::val primInfo = emscripten::val::object();
        primInfo.set("path", bindingPrim.GetPath().GetString());
        emscripten::val relationships = emscripten::val::array();

        size_t relationshipIndex = 0;
        for (const UsdRelationship& relationship : bindingPrim.GetRelationships()) {
            emscripten::val relationshipInfo = emscripten::val::object();
            relationshipInfo.set("name", relationship.GetName().GetString());
            relationshipInfo.set(
                "isMaterialBinding",
                _RelationshipNameLooksLikeMaterialBinding(relationship.GetName()));

            SdfPathVector targets;
            if (!relationship.GetForwardedTargets(&targets) || targets.empty()) {
                targets.clear();
                relationship.GetTargets(&targets);
            }
            if (targets.empty()) {
                targets = _GetRelationshipTargetsFromLayers(bindingPrim, relationship.GetName());
            }
            if (!targets.empty()) {
                emscripten::val targetValues = emscripten::val::array();
                for (size_t targetIndex = 0; targetIndex < targets.size(); ++targetIndex) {
                    targetValues.set(targetIndex, targets[targetIndex].GetString());
                }
                relationshipInfo.set("targets", targetValues);
            }

            relationships.set(relationshipIndex++, relationshipInfo);
        }

        primInfo.set("relationships", relationships);
        result.set(index++, primInfo);
    }

    return result;
}

double
_MaxMatrixDelta(const VtArray<GfMatrix4d>& a, const VtArray<GfMatrix4d>& b)
{
    double maxDelta = 0.0;
    const size_t count = std::min(a.size(), b.size());
    for (size_t matrixIndex = 0; matrixIndex < count; ++matrixIndex) {
        for (int row = 0; row < 4; ++row) {
            for (int col = 0; col < 4; ++col) {
                maxDelta = std::max(
                    maxDelta,
                    std::abs(a[matrixIndex][row][col] - b[matrixIndex][row][col]));
            }
        }
    }
    return maxDelta;
}

emscripten::val
GetSkelDebugInfo(
    const std::string& stagePath,
    const std::string& primPath,
    double timeA,
    double timeB)
{
    emscripten::val info = emscripten::val::object();
    UsdStageRefPtr stage = _GetOrOpenStage(stagePath);
    info.set("stageOpened", static_cast<bool>(stage));
    if (!stage) {
        return info;
    }

    UsdPrim prim = stage->GetPrimAtPath(SdfPath(primPath));
    info.set("primFound", static_cast<bool>(prim));
    if (!prim) {
        return info;
    }

    info.set("primType", prim.GetTypeName().GetString());
    info.set("hasBindingApi", prim.HasAPI<UsdSkelBindingAPI>());

    UsdSkelBindingAPI binding(prim);
    UsdSkelSkeleton directSkeleton;
    const bool hasDirectSkeleton = binding.GetSkeleton(&directSkeleton);
    info.set("hasDirectSkeletonResult", hasDirectSkeleton);
    info.set("directSkeletonPath", directSkeleton
        ? directSkeleton.GetPrim().GetPath().GetString()
        : std::string());

    UsdSkelSkeleton inheritedSkeleton = binding.GetInheritedSkeleton();
    info.set("inheritedSkeletonPath", inheritedSkeleton
        ? inheritedSkeleton.GetPrim().GetPath().GetString()
        : std::string());

    UsdSkelCache* skelCache = _GetOrPopulateSkelCache(stagePath, stage);
    info.set("hasSkelCache", skelCache != nullptr);
    const StageRecord& debugRecord = _GetStageRecord(stagePath);
    info.set(
        "authoredLegacySkelBindingTargetCount",
        debugRecord.authoredLegacySkelBindingTargets.value_or(0));
    if (debugRecord.legacySkelBindingDiagnostics.has_value()) {
        const LegacySkelBindingAuthoringDiagnostics& diag =
            *debugRecord.legacySkelBindingDiagnostics;
        info.set("legacyAuthorSkeletonPrims", diag.skeletonPrims);
        info.set("legacyAuthorAnimationTargets", diag.animationTargets);
        info.set("legacyAuthorMeshPrims", diag.meshPrims);
        info.set("legacyAuthorMeshSkinningQueries", diag.meshSkinningQueries);
        info.set("legacyAuthorMeshInferredSkeletons", diag.meshInferredSkeletons);
        info.set("legacyAuthorRelationshipSpecs", diag.relationshipSpecs);
        info.set("legacyAuthorRelationshipCreateAttempts", diag.relationshipCreateAttempts);
        info.set("legacyAuthorRelationshipCreateFailures", diag.relationshipCreateFailures);
        info.set("legacyAuthorFirstRelationshipFailurePath", diag.firstRelationshipFailurePath);
        info.set("legacyAuthorSessionLayerIdentifier", diag.sessionLayerIdentifier);
    }
    int skelRootCount = 0;
    int skelBindingCount = 0;
    int skelBindingTargetCount = 0;
    if (skelCache) {
        for (const UsdPrim& skelRootPrim : UsdPrimRange(stage->GetPseudoRoot())) {
            if (!skelRootPrim.IsA<UsdSkelRoot>()) {
                continue;
            }
            ++skelRootCount;
            std::vector<UsdSkelBinding> bindings;
            if (skelCache->ComputeSkelBindings(
                    UsdSkelRoot(skelRootPrim),
                    &bindings,
                    UsdTraverseInstanceProxies())) {
                skelBindingCount += static_cast<int>(bindings.size());
                for (const UsdSkelBinding& binding : bindings) {
                    skelBindingTargetCount +=
                        static_cast<int>(binding.GetSkinningTargets().size());
                }
            }
        }
    }
    info.set("skelRootCount", skelRootCount);
    info.set("skelBindingCount", skelBindingCount);
    info.set("skelBindingTargetCount", skelBindingTargetCount);
    UsdSkelSkeleton mappedSkeleton = _FindSkeletonForSkinnedPrim(stagePath, prim);
    info.set("mappedSkeletonPath", mappedSkeleton
        ? mappedSkeleton.GetPrim().GetPath().GetString()
        : std::string());

    if (!skelCache) {
        return info;
    }

    if (UsdSkelSkinningQuery skinningQuery = skelCache->GetSkinningQuery(prim)) {
        info.set("hasSkinningQuery", true);
        info.set("hasBlendShapes", skinningQuery.HasBlendShapes());
        info.set(
            "numInfluencesPerComponent",
            skinningQuery.GetNumInfluencesPerComponent());
        VtTokenArray skinningJointOrder;
        if (skinningQuery.GetJointOrder(&skinningJointOrder)) {
            info.set(
                "skinningJointOrderCount",
                static_cast<int>(skinningJointOrder.size()));
        }
        VtTokenArray blendShapeOrder;
        if (skinningQuery.GetBlendShapeOrder(&blendShapeOrder)) {
            info.set(
                "blendShapeOrderCount",
                static_cast<int>(blendShapeOrder.size()));
        }
        VtArray<int> jointIndices;
        VtArray<float> jointWeights;
        const bool hasInfluences = skinningQuery.ComputeJointInfluences(
            &jointIndices,
            &jointWeights,
            UsdTimeCode(timeA));
        info.set("hasJointInfluences", hasInfluences);
        info.set("jointIndexCount", static_cast<int>(jointIndices.size()));
        info.set("jointWeightCount", static_cast<int>(jointWeights.size()));
    } else {
        info.set("hasSkinningQuery", false);
    }

    UsdSkelSkeleton skeleton =
        mappedSkeleton ? mappedSkeleton :
        inheritedSkeleton ? inheritedSkeleton :
        directSkeleton;
    info.set("debugSkeletonPath", skeleton
        ? skeleton.GetPrim().GetPath().GetString()
        : std::string());

    if (!skeleton) {
        return info;
    }

    UsdPrim animationPrim;
    UsdSkelBindingAPI(skeleton.GetPrim()).GetAnimationSource(&animationPrim);
    info.set("animationSourcePath", animationPrim
        ? animationPrim.GetPath().GetString()
        : std::string());

    UsdSkelSkeletonQuery skelQuery = skelCache->GetSkelQuery(skeleton);
    info.set("hasSkeletonQuery", static_cast<bool>(skelQuery));
    if (!skelQuery) {
        return info;
    }

    const UsdSkelAnimQuery& animQuery = skelQuery.GetAnimQuery();
    info.set("animQueryPath", animQuery
        ? animQuery.GetPrim().GetPath().GetString()
        : std::string());

    VtArray<GfMatrix4d> localA;
    VtArray<GfMatrix4d> localB;
    VtArray<GfMatrix4d> skinA;
    VtArray<GfMatrix4d> skinB;
    info.set(
        "localAComputed",
        skelQuery.ComputeJointLocalTransforms(&localA, UsdTimeCode(timeA)));
    info.set(
        "localBComputed",
        skelQuery.ComputeJointLocalTransforms(&localB, UsdTimeCode(timeB)));
    info.set("localJointCountA", static_cast<int>(localA.size()));
    info.set("localJointCountB", static_cast<int>(localB.size()));
    info.set("localMaxDelta", _MaxMatrixDelta(localA, localB));

    info.set(
        "skinAComputed",
        skelQuery.ComputeSkinningTransforms(&skinA, UsdTimeCode(timeA)));
    info.set(
        "skinBComputed",
        skelQuery.ComputeSkinningTransforms(&skinB, UsdTimeCode(timeB)));
    info.set("skinJointCountA", static_cast<int>(skinA.size()));
    info.set("skinJointCountB", static_cast<int>(skinB.size()));
    info.set("skinMaxDelta", _MaxMatrixDelta(skinA, skinB));

    VtArray<GfMatrix4d> inferredSkinA;
    VtArray<GfMatrix4d> inferredSkinB;
    info.set(
        "inferredSkinAComputed",
        _ComputeInferredSkinningTransforms(
            skelCache,
            skeleton,
            UsdTimeCode(timeA),
            &inferredSkinA,
            &info));
    info.set(
        "inferredSkinBComputed",
        _ComputeInferredSkinningTransforms(
            skelCache,
            skeleton,
            UsdTimeCode(timeB),
            &inferredSkinB));
    info.set("inferredSkinJointCountA", static_cast<int>(inferredSkinA.size()));
    info.set("inferredSkinJointCountB", static_cast<int>(inferredSkinB.size()));
    info.set("inferredSkinMaxDelta", _MaxMatrixDelta(inferredSkinA, inferredSkinB));

    return info;
}

emscripten::val
OpenStage(const std::string& path, bool loadAllPayloads)
{
    _InvalidateDerivedStageCaches(path);
    g_stageRegistry.erase(path);
    UsdStageRefPtr stage = _GetOrOpenStage(path, loadAllPayloads);
    if (!stage) {
        return _ErrorResult(path, "Unable to open USD stage");
    }

    emscripten::val result = emscripten::val::object();
    result.set("rootFile", path);
    result.set("rootLayerIdentifier", _GetLayerIdentifier(stage->GetRootLayer()));
    result.set("primCount", _CountPrims(stage));
    result.set("layerCount", static_cast<int>(stage->GetUsedLayers().size()));
    const StageAuthoredStats stats = _CollectStageAuthoredStats(stage);
    result.set("meshPrimCount", stats.meshPrimCount);
    result.set("authoredPointCount", stats.authoredPointCount);
    result.set("authoredFaceCount", stats.authoredFaceCount);
    result.set("materialPrimCount", stats.materialPrimCount);
    result.set("materialBindingCount", stats.materialBindingCount);
    result.set("textureAssetCount", stats.textureAssetCount);
    result.set("payloadPrimCount", stats.payloadPrimCount);
    result.set("variantSetCount", stats.variantSetCount);
    result.set("instancePrimCount", stats.instancePrimCount);
    result.set("timeCodesPerSecond", stage->GetTimeCodesPerSecond());
    result.set("startTimeCode", stage->GetStartTimeCode());
    result.set("endTimeCode", stage->GetEndTimeCode());
    result.set("upAxis", UsdGeomGetStageUpAxis(stage).GetString());
    emscripten::val environment = _ExtractStageEnvironment(stage);
    if (!environment.isUndefined()) {
        result.set("environment", environment);
    }
    return result;
}

emscripten::val
ExtractTransformsAtTime(const std::string& path, double timeCode)
{
    emscripten::val transforms = emscripten::val::array();
    UsdStageRefPtr stage = _GetOrOpenStage(path);
    if (!stage) {
        return transforms;
    }

    UsdGeomXformCache xformCache(timeCode);
    size_t index = 0;

    for (const UsdPrim& prim : UsdPrimRange(stage->GetPseudoRoot())) {
        if (!prim.IsA<UsdGeomMesh>()) {
            continue;
        }
        emscripten::val entry = emscripten::val::object();
        entry.set("path", prim.GetPath().GetString());
        entry.set("matrix", _MatrixArray(xformCache.GetLocalToWorldTransform(prim)));
        transforms.set(index++, entry);
    }

    return transforms;
}

emscripten::val
GetSceneGraph(const std::string& path)
{
    emscripten::val result = emscripten::val::array();
    UsdStageRefPtr stage = _GetOrOpenStage(path);
    if (!stage) {
        return result;
    }

    // Include prims with unloaded payloads so the scene graph retains
    // their entries (with a ghostly P button) even after unloading.
    // UsdPrimDefaultPredicate also requires UsdPrimIsLoaded which would
    // silently drop them from traversal.
    const auto traversePredicate =
        UsdPrimIsActive && UsdPrimIsDefined && !UsdPrimIsAbstract;

    size_t index = 0;
    for (const UsdPrim& prim : UsdPrimRange(stage->GetPseudoRoot(), traversePredicate)) {
        if (prim.IsPseudoRoot()) {
            continue;
        }

        // hasChildren should reflect what's visible under current load state
        // (use default predicate children so collapsed payload children are hidden)
        const auto children = prim.GetFilteredChildren(UsdPrimDefaultPredicate);
        emscripten::val item = emscripten::val::object();
        item.set("path", prim.GetPath().GetString());
        item.set("name", prim.GetName().GetString());
        item.set("typeName", prim.GetTypeName().GetString());
        item.set("depth", static_cast<int>(prim.GetPath().GetPathElementCount()) - 1);
        item.set("isActive", prim.IsActive());
        item.set("hasChildren", children.begin() != children.end());
        item.set("hasVariantSets", !prim.GetVariantSets().GetNames().empty());
        item.set("hasPayloads", prim.HasPayload());
        item.set("isPayloadLoaded", prim.IsLoaded());
        result.set(index++, item);
    }

    return result;
}

bool
_IsEditableScalarAttribute(const UsdPrim& prim, const UsdAttribute& attr)
{
    if (!attr || attr.ValueMightBeTimeVarying()) {
        return false;
    }

    const std::string name = attr.GetName().GetString();
    const SdfValueTypeName typeName = attr.GetTypeName();
    if (UsdLuxDomeLight(prim)) {
        const bool editableDomeName =
            name == "inputs:intensity" ||
            name == "inputs:exposure" ||
            name == "inputs:texture:rotation";
        return editableDomeName &&
            (typeName == SdfValueTypeNames->Float ||
             typeName == SdfValueTypeNames->Double ||
             typeName == SdfValueTypeNames->Int);
    }

    if (name == "inputs:color") {
        return typeName == SdfValueTypeNames->Color3f;
    }

    const bool editableName =
        name == "inputs:intensity" ||
        name == "inputs:exposure" ||
        name == "inputs:diffuse" ||
        name == "inputs:specular" ||
        name == "inputs:normalize" ||
        name == "inputs:enableColorTemperature" ||
        name == "inputs:colorTemperature" ||
        name == "inputs:radius" ||
        name == "inputs:width" ||
        name == "inputs:height" ||
        name == "inputs:angle" ||
        name == "inputs:shaping:cone:angle" ||
        name == "inputs:shaping:cone:softness";
    return editableName &&
        (typeName == SdfValueTypeNames->Float ||
         typeName == SdfValueTypeNames->Double ||
         typeName == SdfValueTypeNames->Int ||
         typeName == SdfValueTypeNames->Bool);
}

emscripten::val
GetPrimAttributes(const std::string& stagePath, const std::string& primPath)
{
    emscripten::val result = emscripten::val::array();
    UsdStageRefPtr stage = _GetOrOpenStage(stagePath);
    if (!stage) {
        return result;
    }

    const UsdPrim prim = stage->GetPrimAtPath(SdfPath(primPath));
    if (!prim) {
        return result;
    }

    size_t index = 0;
    for (const UsdAttribute& attr : prim.GetAttributes()) {
        emscripten::val item = emscripten::val::object();
        item.set("name", attr.GetName().GetString());
        item.set("typeName", attr.GetTypeName().GetAsToken().GetString());
        item.set("isAuthored", attr.IsAuthored());
        item.set("editable", static_cast<bool>(UsdLuxLightAPI(prim)) && _IsEditableScalarAttribute(prim, attr));

        VtValue value;
        if (attr.Get(&value)) {
            std::string str;
            if (value.IsArrayValued() && value.GetArraySize() > 8) {
                item.set("valueIsArray", true);
                item.set("valueElementCount", value.GetArraySize());
                if (!_FormatVtArrayPreview(value, &str)) {
                    str = "[" + std::to_string(value.GetArraySize()) + " elements]";
                }
            } else {
                std::ostringstream oss;
                oss << value;
                str = oss.str();
                if (str.size() > 140) {
                    str = str.substr(0, 140) + "...";
                }
            }
            item.set("value", str);
        }

        result.set(index++, item);
    }

    if (UsdLuxDomeLight(prim) && !prim.HasAttribute(TfToken("inputs:texture:rotation"))) {
        emscripten::val item = emscripten::val::object();
        item.set("name", std::string("inputs:texture:rotation"));
        item.set("typeName", std::string("float"));
        item.set("isAuthored", false);
        item.set("editable", true);
        item.set("value", std::string("0"));
        result.set(index++, item);
    }

    // Append variant sets as pseudo-attributes at the end
    const UsdVariantSets variantSets = prim.GetVariantSets();
    for (const std::string& vsName : variantSets.GetNames()) {
        const UsdVariantSet vs = variantSets.GetVariantSet(vsName);
        emscripten::val item = emscripten::val::object();
        item.set("name", vsName);
        item.set("typeName", std::string("variantSet"));
        item.set("isAuthored", true);
        item.set("value", vs.GetVariantSelection());

        const std::vector<std::string> variantNames = vs.GetVariantNames();
        emscripten::val options = emscripten::val::array();
        for (size_t i = 0; i < variantNames.size(); ++i) {
            options.set(i, variantNames[i]);
        }
        item.set("variantOptions", options);

        result.set(index++, item);
    }

    return result;
}

emscripten::val
ExtractStageEnvironment(const std::string& stagePath)
{
    UsdStageRefPtr stage = _GetOrOpenStage(stagePath);
    return _ExtractStageEnvironment(stage);
}

bool
_SetAttributeFromString(const UsdAttribute& attr, const std::string& value)
{
    const SdfValueTypeName typeName = attr.GetTypeName();
    try {
        if (typeName == SdfValueTypeNames->Float) {
            attr.Set(std::stof(value));
            return true;
        }
        if (typeName == SdfValueTypeNames->Double) {
            attr.Set(std::stod(value));
            return true;
        }
        if (typeName == SdfValueTypeNames->Int) {
            attr.Set(std::stoi(value));
            return true;
        }
        if (typeName == SdfValueTypeNames->Bool) {
            const std::string lower = TfStringToLower(value);
            attr.Set(lower == "1" || lower == "true" || lower == "yes" || lower == "on");
            return true;
        }
        if (typeName == SdfValueTypeNames->String) {
            attr.Set(value);
            return true;
        }
        if (typeName == SdfValueTypeNames->Token) {
            attr.Set(TfToken(value));
            return true;
        }
        if (typeName == SdfValueTypeNames->Color3f) {
            std::string normalized = value;
            for (char& ch : normalized) {
                if (ch == '(' || ch == ')' || ch == ',') {
                    ch = ' ';
                }
            }
            std::istringstream input(normalized);
            float r = 0.0f;
            float g = 0.0f;
            float b = 0.0f;
            if (!(input >> r >> g >> b)) {
                return false;
            }
            attr.Set(GfVec3f(r, g, b));
            return true;
        }
    } catch (...) {
        return false;
    }
    return false;
}

bool
SetPrimAttribute(
    const std::string& stagePath,
    const std::string& primPath,
    const std::string& attrName,
    const std::string& value)
{
    UsdStageRefPtr stage = _GetOrOpenStage(stagePath);
    if (!stage) return false;

    UsdPrim prim = stage->GetPrimAtPath(SdfPath(primPath));
    if (!prim || !UsdLuxLightAPI(prim)) return false;

    UsdAttribute attr = prim.GetAttribute(TfToken(attrName));
    if (!attr && UsdLuxDomeLight(prim) && attrName == "inputs:texture:rotation") {
        UsdEditContext ctx(stage, stage->GetSessionLayer());
        attr = prim.CreateAttribute(TfToken(attrName), SdfValueTypeNames->Float);
    }
    if (!attr || !_IsEditableScalarAttribute(prim, attr)) return false;

    bool changed = false;
    {
        UsdEditContext ctx(stage, stage->GetSessionLayer());
        changed = _SetAttributeFromString(attr, value);
    }
    if (!changed) return false;

    _InvalidateDerivedStageCaches(stagePath);
    return true;
}

bool
ReopenStage(const std::string& stagePath)
{
    SdfLayerHandle layer = SdfLayer::Find(stagePath);
    _InvalidateDerivedStageCaches(stagePath);

    auto registryIt = g_stageRegistry.find(stagePath);
    const bool hasCachedStage =
        registryIt != g_stageRegistry.end() && registryIt->second.stage;
    if (layer && hasCachedStage) {
        // Fast path: reload fires SdfNotice::LayersDidChange to the living
        // stage. USD's PCP change-processing recomposes only the prim subtrees
        // whose fields actually changed (e.g. one VariantSelection field) —
        // not the whole stage. For large scenes this is orders of magnitude
        // cheaper than a full UsdStage::Open.
        layer->Reload(/* force= */ true);
        return true;
    }

    // Slow path: stage not yet cached or layer not in registry.
    // Reload first so UsdStage::Open reads the updated VFS content.
    if (layer) {
        layer->Reload(/* force= */ true);
    }
    StageRecord& record = _GetStageRecord(stagePath);
    record.stage.Reset();
    UsdStageRefPtr newStage =
        _OpenStageWithPayloadPolicy(stagePath, record.loadAllPayloadsOnOpen);
    if (!newStage) return false;
    record.stage = newStage;
    return true;
}

bool
SetVariantSelection(
    const std::string& stagePath,
    const std::string& primPath,
    const std::string& variantSetName,
    const std::string& selection)
{
    UsdStageRefPtr stage = _GetOrOpenStage(stagePath);
    if (!stage) return false;

    const UsdPrim prim = stage->GetPrimAtPath(SdfPath(primPath));
    if (!prim) return false;

    UsdVariantSet vs = prim.GetVariantSets().GetVariantSet(variantSetName);
    if (!vs.IsValid()) return false;
    if (vs.GetVariantSelection() == selection) return true;

    // Write the selection into the session layer (strongest arc, fully
    // in-memory). Unlike root-layer edits this does not touch the VFS,
    // sidestepping the MEMFS write restrictions that broke earlier attempts.
    // Verify by reading back rather than trusting the return value — WASM
    // TfType/RTTI issues can cause SetVariantSelection to report false even
    // when the write succeeded.
    {
        UsdEditContext ctx(stage, stage->GetSessionLayer());
        vs.SetVariantSelection(selection);
    }
    _InvalidateDerivedStageCaches(stagePath);
    return vs.GetVariantSelection() == selection;
}

bool
SetPayloadLoaded(
    const std::string& stagePath,
    const std::string& primPath,
    bool loaded)
{
    UsdStageRefPtr stage = _GetOrOpenStage(stagePath);
    if (!stage) return false;

    const SdfPath path(primPath);
    const UsdPrim prim = stage->GetPrimAtPath(path);
    if (!prim) return false;
    if (prim.IsLoaded() == loaded) return true;

    if (loaded) {
        stage->Load(path);
    } else {
        stage->Unload(path);
    }
    _InvalidateDerivedStageCaches(stagePath);
    const UsdPrim updatedPrim = stage->GetPrimAtPath(path);
    return updatedPrim && updatedPrim.IsLoaded() == loaded;
}

void
SetAllPayloadsLoaded(const std::string& stagePath, bool loaded)
{
    UsdStageRefPtr stage = _GetOrOpenStage(stagePath);
    if (!stage) return;

    const auto traversePredicate =
        UsdPrimIsActive && UsdPrimIsDefined && !UsdPrimIsAbstract;
    SdfPathSet loadSet;
    SdfPathSet unloadSet;

    for (const UsdPrim& prim : UsdPrimRange(stage->GetPseudoRoot(), traversePredicate)) {
        if (prim.HasPayload()) {
            if (loaded) {
                loadSet.insert(prim.GetPath());
            } else {
                unloadSet.insert(prim.GetPath());
            }
        }
    }
    if (loadSet.empty() && unloadSet.empty()) return;
    stage->LoadAndUnload(loadSet, unloadSet);
    _InvalidateDerivedStageCaches(stagePath);
}

void
CloseStage(const std::string& stagePath)
{
    // Drops the stage record (composed stage, skel caches, hydra animation
    // driver, overlay diagnostics) for a path. The JS wrapper pairs this with
    // unlinking the stage's MEMFS files.
    g_stageRegistry.erase(stagePath);
    DeleteStageDriver(stagePath);
}

// Authored-material supplier: one entry per bound material prim, keyed by
// material path. Meshes and their GeomSubsets are walked with the same
// binding resolution the legacy extractor used; the legacy extraction stops
// being a mesh source once the unified driver supplies geometry.
emscripten::val
ExtractMaterialPayloads(const std::string& stagePath)
{
    emscripten::val payloads = emscripten::val::array();
    UsdStageRefPtr stage = _GetOrOpenStage(stagePath);
    if (!stage) {
        return payloads;
    }

    const std::string packageRootPath =
        _GetLayerIdentifier(stage->GetRootLayer());
    UsdShadeMaterialBindingAPI::BindingsCache bindingsCache;
    UsdShadeMaterialBindingAPI::CollectionQueryCache collectionQueryCache;
    const emscripten::val undefinedColor = emscripten::val::undefined();

    std::set<std::string> seenMaterialPaths;
    size_t payloadIndex = 0;
    auto appendMaterialFor = [&](const UsdPrim& bindingPrim) {
        emscripten::val material = _ExtractMaterial(
            bindingPrim,
            packageRootPath,
            &bindingsCache,
            &collectionQueryCache,
            undefinedColor);
        if (material.isUndefined() || material["path"].isUndefined()) {
            return;
        }
        const std::string materialPath =
            material["path"].as<std::string>();
        if (!seenMaterialPaths.insert(materialPath).second) {
            return;
        }
        emscripten::val entry = emscripten::val::object();
        entry.set("path", materialPath);
        entry.set("material", material);
        payloads.set(payloadIndex++, entry);
    };

    for (const UsdPrim& prim : stage->Traverse()) {
        if (prim.IsA<UsdGeomMesh>()) {
            appendMaterialFor(prim);
            for (const UsdGeomSubset& subset : UsdGeomSubset::GetGeomSubsets(
                     UsdGeomImageable(prim),
                     UsdGeomTokens->face,
                     TfToken("materialBind"))) {
                appendMaterialFor(subset.GetPrim());
            }
        }
    }
    return payloads;
}

} // namespace usdwebview
