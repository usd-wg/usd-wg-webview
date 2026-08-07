// Shared declarations for the usd-webview bindings translation units.
// Everything lives in namespace usdwebview; bindings.cpp exposes the public
// entry points to JS via EMSCRIPTEN_BINDINGS.

#ifndef USD_WEBVIEW_COMMON_H
#define USD_WEBVIEW_COMMON_H

#include "pxr/pxr.h"

#include "pxr/base/plug/registry.h"
#include "pxr/base/tf/fileUtils.h"
#include "pxr/base/tf/pathUtils.h"
#include "pxr/base/tf/stringUtils.h"
#include "pxr/base/tf/type.h"
#include "pxr/base/vt/array.h"
#include "pxr/base/gf/half.h"
#include "pxr/base/gf/interval.h"
#include "pxr/base/gf/matrix4d.h"
#include "pxr/base/gf/quath.h"
#include "pxr/base/gf/vec2f.h"
#include "pxr/base/gf/vec3d.h"
#include "pxr/base/gf/vec3f.h"
#include "pxr/base/gf/vec3h.h"
#include "pxr/base/gf/vec4f.h"
#include "pxr/base/tf/token.h"
#include "pxr/imaging/hd/bprim.h"
#include "pxr/imaging/hd/camera.h"
#include "pxr/imaging/hd/changeTracker.h"
#include "pxr/imaging/hd/coordSys.h"
#include "pxr/imaging/hd/extComputation.h"
#include "pxr/imaging/hd/extComputationPrimvarsSchema.h"
#include "pxr/imaging/hd/extComputationUtils.h"
#include "pxr/imaging/hd/engine.h"
#include "pxr/imaging/hd/filteringSceneIndex.h"
#include "pxr/imaging/hd/instancer.h"
#include "pxr/imaging/hd/light.h"
#include "pxr/imaging/hd/material.h"
#include "pxr/imaging/hd/mesh.h"
#include "pxr/imaging/hd/meshUtil.h"
#include "pxr/imaging/hd/smoothNormals.h"
#include "pxr/imaging/pxOsd/tokens.h"
#include "pxr/imaging/hd/vertexAdjacency.h"
#include "pxr/imaging/hd/overlayContainerDataSource.h"
#include "pxr/imaging/hd/renderDelegate.h"
#include "pxr/imaging/hd/renderIndex.h"
#include "pxr/imaging/hd/renderPass.h"
#include "pxr/imaging/hd/resourceRegistry.h"
#include "pxr/imaging/hd/rprimCollection.h"
#include "pxr/imaging/hd/sceneIndexAdapterSceneDelegate.h"
#include "pxr/imaging/hd/retainedDataSource.h"
#include "pxr/imaging/hd/tokens.h"
#include "pxr/imaging/hd/unitTestNullRenderPass.h"
#include "pxr/imaging/hdsi/sceneGlobalsSceneIndex.h"
#include "pxr/usd/ar/asset.h"
#include "pxr/usd/ar/definePackageResolver.h"
#include "pxr/usd/ar/packageUtils.h"
#include "pxr/usd/ar/packageResolver.h"
#include "pxr/usd/ar/resolvedPath.h"
#include "pxr/usd/ar/resolver.h"
#include "pxr/usd/sdf/layer.h"
#include "pxr/usd/sdf/path.h"
#include "pxr/usd/sdf/fileFormat.h"
#include "pxr/usd/sdf/assetPath.h"
#include "pxr/usd/sdf/primSpec.h"
#include "pxr/usd/sdf/relationshipSpec.h"
#include "pxr/usd/sdf/schema.h"
#include "pxr/usd/sdf/usdzFileFormat.h"
#include "pxr/base/vt/dictionary.h"
#include "pxr/usd/sdf/usdzResolver.h"
#include "pxr/usd/usd/attribute.h"
#include "pxr/usd/usd/editContext.h"
#include "pxr/usd/usd/prim.h"
#include "pxr/usd/usd/primRange.h"
#include "pxr/usd/usd/relationship.h"
#include "pxr/usd/usd/stage.h"
#include "pxr/usd/usd/timeCode.h"
#include "pxr/usd/usd/variantSets.h"
#include "pxr/usd/usdGeom/gprim.h"
#include "pxr/usd/usdGeom/metrics.h"
#include "pxr/usd/usdGeom/mesh.h"
#include "pxr/usd/usdGeom/pointInstancer.h"
#include "pxr/usd/usdGeom/primvar.h"
#include "pxr/usd/usdGeom/primvarsAPI.h"
#include "pxr/usd/usdGeom/subset.h"
#include "pxr/usd/usdGeom/tokens.h"
#include "pxr/usd/usdGeom/xformCache.h"
#include "pxr/usd/usdLux/cylinderLight.h"
#include "pxr/usd/usdLux/diskLight.h"
#include "pxr/usd/usdLux/distantLight.h"
#include "pxr/usd/usdLux/domeLight.h"
#include "pxr/usd/usdLux/domeLight_1.h"
#include "pxr/usd/usdLux/geometryLight.h"
#include "pxr/usd/usdLux/lightAPI.h"
#include "pxr/usd/usdLux/meshLightAPI.h"
#include "pxr/usd/usdLux/pluginLight.h"
#include "pxr/usd/usdLux/portalLight.h"
#include "pxr/usd/usdLux/rectLight.h"
#include "pxr/usd/usdLux/shadowAPI.h"
#include "pxr/usd/usdLux/shapingAPI.h"
#include "pxr/usd/usdLux/sphereLight.h"
#include "pxr/usd/usdLux/volumeLightAPI.h"
#include "pxr/usd/usdShade/connectableAPI.h"
#include "pxr/usd/usdShade/input.h"
#include "pxr/usd/usdShade/material.h"
#include "pxr/usd/usdShade/materialBindingAPI.h"
#include "pxr/usd/usdShade/shader.h"
#include "pxr/usd/usdShade/tokens.h"
#include "pxr/usd/usdSkel/animQuery.h"
#include "pxr/usd/usdSkel/animMapper.h"
#include "pxr/usd/usdSkel/animation.h"
#include "pxr/usd/usdSkel/bakeSkinning.h"
#include "pxr/usd/usdSkel/binding.h"
#include "pxr/usd/usdSkel/bindingAPI.h"
#include "pxr/usd/usdSkel/cache.h"
#include "pxr/usd/usdSkel/root.h"
#include "pxr/usd/usdSkel/skeleton.h"
#include "pxr/usd/usdSkel/skeletonQuery.h"
#include "pxr/usd/usdSkel/skinningQuery.h"
#include "pxr/usd/usdSkel/utils.h"
#include "pxr/usdImaging/usdImaging/delegate.h"
#include "pxr/usdImaging/usdSkelImaging/animationAdapter.h"
#include "pxr/usdImaging/usdSkelImaging/animationSchema.h"
#include "pxr/usdImaging/usdSkelImaging/bindingAPIAdapter.h"
#include "pxr/usdImaging/usdSkelImaging/bindingSchema.h"
#include "pxr/usdImaging/usdSkelImaging/blendShapeAdapter.h"
#include "pxr/usdImaging/usdSkelImaging/resolvedSkeletonSchema.h"
#include "pxr/usdImaging/usdSkelImaging/resolvingSceneIndexPlugin.h"
#include "pxr/usdImaging/usdSkelImaging/skelRootAdapter.h"
#include "pxr/usdImaging/usdSkelImaging/skeletonAdapter.h"
#include "pxr/usdImaging/usdImaging/sceneIndices.h"
#include "pxr/usdImaging/usdImaging/stageSceneIndex.h"

#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cctype>
#include <limits>
#include <map>
#include <memory>
#include <sstream>
#include <iomanip>
#include <string>
#include <chrono>
#include <set>
#include <deque>
#include <optional>
#include <unordered_map>
#include <vector>
#include <unordered_set>

PXR_NAMESPACE_USING_DIRECTIVE

namespace usdwebview {

struct MeshPayload
{
    std::vector<float> points;
    std::vector<int> triangleIndices;
    std::vector<float> uvs;
    std::vector<int> faceIndexStarts;
    std::vector<int> faceIndexCounts;
};

struct MaterialSubsetGroup
{
    UsdPrim prim;
    int start = 0;
    int count = 0;
};

struct LegacySkelBindingAuthoringDiagnostics
{
    int skeletonPrims = 0;
    int animationTargets = 0;
    int meshPrims = 0;
    int meshSkinningQueries = 0;
    int meshInferredSkeletons = 0;
    int relationshipSpecs = 0;
    int relationshipCreateAttempts = 0;
    int relationshipCreateFailures = 0;
    std::string firstRelationshipFailurePath;
    std::string sessionLayerIdentifier;
};

// One record per stage path: consolidates every per-stage cache that used to
// live in separate g_* maps so open/invalidate/close stay coherent and
// CloseStage can drop everything at once.
struct StageRecord
{
    UsdStageRefPtr stage;
    bool loadAllPayloadsOnOpen = true;
    std::unique_ptr<UsdSkelCache> skelCache;
    std::optional<bool> hasSkelRoot;
    std::unordered_map<std::string, UsdSkelSkeleton> skinningSkeletonByPrim;
    std::optional<int> authoredLegacySkelBindingTargets;
    std::optional<LegacySkelBindingAuthoringDiagnostics>
        legacySkelBindingDiagnostics;
    std::string lastSkelBindingOverlayContents;

    void ResetDerivedCaches()
    {
        skelCache.reset();
        hasSkelRoot.reset();
        skinningSkeletonByPrim.clear();
        authoredLegacySkelBindingTargets.reset();
        legacySkelBindingDiagnostics.reset();
    }
};

// --- stageRegistry.cpp ----------------------------------------------------

extern std::unordered_map<std::string, StageRecord> g_stageRegistry;

StageRecord& _GetStageRecord(const std::string& path);
std::string _GetLayerIdentifier(const SdfLayerHandle& layer);
UsdStageRefPtr _OpenStageWithPayloadPolicy(const std::string& path, bool loadAllPayloads);
UsdStageRefPtr _GetOrOpenStage(const std::string& path, bool loadAllPayloads = true);
void _InvalidateDerivedStageCaches(const std::string& path);
UsdSkelCache* _GetOrPopulateSkelCache(const std::string& path, const UsdStageRefPtr& stage);
UsdSkelSkeleton _FindSkeletonForSkinnedPrim(const std::string& stagePath, const UsdPrim& prim);

// --- jsInterop.cpp ----------------------------------------------------------

emscripten::val _FloatArray(const std::vector<float>& values);
emscripten::val _IntArray(const std::vector<int>& values);
emscripten::val _MatrixArray(const GfMatrix4d& matrix);
emscripten::val _MatrixArrayVector(const std::vector<GfMatrix4d>& matrices);
emscripten::val _Float32Array(const std::vector<float>& values);
emscripten::val _Float32View(const std::vector<float>& values);
emscripten::val _Vec3Array(const GfVec3f& value);
emscripten::val _BytesArray(const std::vector<unsigned char>& bytes);
emscripten::val _ErrorResult(const std::string& path, const std::string& message);
bool _FormatVtArrayPreview(const VtValue& value, std::string* result);

// --- skelBinding.cpp --------------------------------------------------------

SdfPrimSpecHandle _EnsurePrimSpecInLayer(const SdfLayerHandle& layer, const SdfPath& primPath);
SdfRelationshipSpecHandle _EnsureRelationshipSpecInLayer(
    const SdfLayerHandle& layer,
    const SdfPath& primPath,
    const TfToken& relationshipName,
    LegacySkelBindingAuthoringDiagnostics* diagnostics = nullptr);
UsdPrim _InferSkeletonForSkelBoundPrim(const UsdPrim& prim);
UsdPrim _InferAnimationForSkeleton(const UsdPrim& skeleton);
bool _ComputeInferredSkinningTransforms(
    const UsdSkelCache* skelCache,
    const UsdSkelSkeleton& skeleton,
    UsdTimeCode timeCode,
    VtArray<GfMatrix4d>* skinningTransforms,
    emscripten::val* debugInfo = nullptr);
int _AuthorInferredSkelBindingTargetsToLayer(
    const UsdStageRefPtr& sourceStage,
    const SdfLayerHandle& targetLayer,
    LegacySkelBindingAuthoringDiagnostics* diagnostics);

// --- materials.cpp ----------------------------------------------------------

bool _RelationshipNameLooksLikeMaterialBinding(const TfToken& name);
SdfPathVector _GetRelationshipTargetsFromLayers(const UsdPrim& prim, const TfToken& relName);
UsdPrim _FindBoundMaterialPrimByAuthoredRelationships(const UsdPrim& prim);
bool _GetMaterialXSourceAsset(
    const UsdShadeShader& shader,
    SdfAssetPath* sourceAsset,
    TfToken* subIdentifier,
    TfToken* sourceTypeOut = nullptr);
emscripten::val _ColorArray(const UsdGeomMesh& mesh);
emscripten::val _ReadTextureAsset(const std::string& path, const std::string& packageRootPath);
emscripten::val _ExtractMaterial(
    const UsdPrim& prim,
    const std::string& packageRootPath,
    UsdShadeMaterialBindingAPI::BindingsCache* bindingsCache,
    UsdShadeMaterialBindingAPI::CollectionQueryCache* collectionQueryCache,
    const emscripten::val& fallbackColor);
void _MaybeSetRenderableMaterialSubsets(
    emscripten::val* renderable,
    const UsdGeomMesh& mesh,
    const MeshPayload& payload,
    const std::string& packageRootPath,
    UsdShadeMaterialBindingAPI::BindingsCache* bindingsCache,
    UsdShadeMaterialBindingAPI::CollectionQueryCache* collectionQueryCache);

// --- lights.cpp -------------------------------------------------------------

emscripten::val _ExtractStageEnvironment(const UsdStageRefPtr& stage);
emscripten::val _ExtractStageLights(const UsdStageRefPtr& stage, UsdTimeCode timeCode);

// --- meshExtraction.cpp -----------------------------------------------------

VtArray<GfVec3f> _GetMeshPointsAsFloat(const UsdGeomMesh& mesh, UsdTimeCode timeCode);
bool _ExtractMeshPayload(
    const UsdGeomMesh& mesh,
    MeshPayload* payload,
    UsdTimeCode timeCode = UsdTimeCode::Default(),
    const UsdSkelCache* skelCache = nullptr,
    const UsdSkelSkeleton& skel = UsdSkelSkeleton(),
    UsdGeomXformCache* xformCache = nullptr);

// --- pointInstancer.cpp -----------------------------------------------------

bool _PathHasPrefixInList(const SdfPath& path, const std::vector<SdfPath>& prefixes);
std::vector<SdfPath> _CollectPointInstancerPrototypeRoots(const UsdStageRefPtr& stage);
void _AppendPointInstancerRenderablesAtTime(
    emscripten::val* renderables,
    size_t* renderableIndex,
    const std::string& stagePath,
    const UsdStageRefPtr& stage,
    const std::string& packageRootPath,
    UsdTimeCode timeCode,
    bool includeMaterials,
    const SdfPath& rootPath,
    const std::vector<SdfPath>& prototypeRoots,
    const UsdSkelCache* skelCache,
    UsdShadeMaterialBindingAPI::BindingsCache* bindingsCache,
    UsdShadeMaterialBindingAPI::CollectionQueryCache* collectionQueryCache);

// --- stageApi.cpp (public entry points) --------------------------------------

void InitializeRuntime();
emscripten::val GetRuntimeDiagnostics();
std::string GetLastSkelBindingOverlayContents(const std::string& stagePath);
emscripten::val InspectPrimRelationships(const std::string& stagePath, const std::string& primPath);
emscripten::val GetSkelDebugInfo(
    const std::string& stagePath,
    const std::string& primPath,
    double timeA,
    double timeB);
emscripten::val OpenStage(const std::string& path, bool loadAllPayloads = true);
emscripten::val ExtractTransformsAtTime(const std::string& path, double timeCode);
emscripten::val GetSceneGraph(const std::string& path);
emscripten::val GetPrimAttributes(const std::string& stagePath, const std::string& primPath);
bool SetPrimAttribute(
    const std::string& stagePath,
    const std::string& primPath,
    const std::string& attrName,
    const std::string& value);
emscripten::val ExtractStageEnvironment(const std::string& stagePath);
emscripten::val ExtractStageLights(const std::string& stagePath, double timeCode);
bool ReopenStage(const std::string& stagePath);
bool SetVariantSelection(
    const std::string& stagePath,
    const std::string& primPath,
    const std::string& variantSetName,
    const std::string& selection);
bool SetPayloadLoaded(
    const std::string& stagePath,
    const std::string& primPath,
    bool loaded);
void SetAllPayloadsLoaded(const std::string& stagePath, bool loaded);
void CloseStage(const std::string& stagePath);
emscripten::val ExtractMaterialPayloads(const std::string& stagePath);

// --- splats.cpp (public entry point) -----------------------------------------

emscripten::val ExtractGaussianSplats(const std::string& path);

// --- unifiedDriver.cpp (public entry points) ----------------------------------

bool CreateStageDriver(const std::string& stagePath);
void DeleteStageDriver(const std::string& stagePath);
void StageDriverSetTime(const std::string& stagePath, double timeCode);
emscripten::val StageDriverDraw(
    const std::string& stagePath,
    bool full,
    const std::string& purposePolicy = "defaultRender");
emscripten::val StageDriverDrawSubtree(
    const std::string& stagePath,
    const std::string& primPath,
    const std::string& purposePolicy = "defaultRender");
emscripten::val StageDriverGetTiming(const std::string& stagePath);
emscripten::val StageDriverGetCapabilities(const std::string& stagePath);
emscripten::val StageDriverGetDiagnostics(const std::string& stagePath);
void StageDriverNotifyStageEdited(const std::string& stagePath);

} // namespace usdwebview

#endif // USD_WEBVIEW_COMMON_H
