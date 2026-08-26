#include "webviewCommon.h"

namespace usdwebview {

// ---------------------------------------------------------------------------
// WebViewStageDriver (Phase 3): the single geometry authority.
//
// One driver per stage path, owned by the StageRecord. It composes a private
// driver stage — root layer shared with the inspection stage, plus an
// anonymous driver session layer that sublayers the inspection stage's
// session layer (so variant/payload edits propagate by composition).
// Skel-binding inference opinions and UsdSkelBakeSkinning output land only
// in the driver session; the shared stage is never mutated.
// ---------------------------------------------------------------------------

struct StageDriverCapabilities
{
    bool hasSkelContent = false;
    bool skelBindingsInferred = false;
    bool hasTimeVaryingPoints = false;
    bool hasTimeVaryingXforms = false;
    bool hasAnimationRange = false;
    bool hasPointInstancers = false;
    bool hasMaterialX = false;
    bool hasGaussianSplats = false;
};

class WebViewStageDriver
{
public:
    explicit WebViewStageDriver(std::string stagePath)
        : _stagePath(std::move(stagePath))
    {
        _inspectionStage = _GetOrOpenStage(_stagePath);
        if (!_inspectionStage) {
            return;
        }
        _driverSession = SdfLayer::CreateAnonymous(".usda");
        RebuildDriverStage();
        _timeCode = GetStartTimeCode();
    }

    bool IsValid() const { return bool(_driverStage); }

    void NotifyStageEdited()
    {
        if (_inspectionStage) {
            RebuildDriverStage();
        }
    }

    void SetTime(double timeCode) { _timeCode = timeCode; }

    double GetStartTimeCode() const
    {
        return _driverStage ? _driverStage->GetStartTimeCode() : 0.0;
    }

    double GetEndTimeCode() const
    {
        return _driverStage ? _driverStage->GetEndTimeCode() : 0.0;
    }

    double GetTimeCodesPerSecond() const
    {
        return _driverStage ? _driverStage->GetTimeCodesPerSecond() : 24.0;
    }

    emscripten::val GetCapabilities() const
    {
        emscripten::val caps = emscripten::val::object();
        caps.set("hasSkelContent", _capabilities.hasSkelContent);
        caps.set("skelBindingsInferred", _capabilities.skelBindingsInferred);
        caps.set("hasTimeVaryingPoints", _capabilities.hasTimeVaryingPoints);
        caps.set("hasTimeVaryingXforms", _capabilities.hasTimeVaryingXforms);
        caps.set("hasAnimationRange", _capabilities.hasAnimationRange);
        caps.set("hasPointInstancers", _capabilities.hasPointInstancers);
        caps.set("hasMaterialX", _capabilities.hasMaterialX);
        caps.set("hasGaussianSplats", _capabilities.hasGaussianSplats);
        return caps;
    }

    emscripten::val GetDiagnostics() const
    {
        emscripten::val info = emscripten::val::object();
        info.set("capabilities", GetCapabilities());
        info.set("inferredBindingCount", _inferredBindingCount);
        info.set("bakeTimeMs", _bakeTimeMs);
        info.set("rootLayerClean", _rootLayerCleanAfterBake);
        info.set("inspectionSessionClean", _inspectionSessionCleanAfterBake);
        return info;
    }

    emscripten::val Draw(bool full)
    {
        return _Draw(full, SdfPath::AbsoluteRootPath(), "defaultRender");
    }

    emscripten::val Draw(bool full, const std::string& purposePolicy)
    {
        return _Draw(full, SdfPath::AbsoluteRootPath(), purposePolicy);
    }

    emscripten::val DrawSubtree(const std::string& primPath)
    {
        return _Draw(true, SdfPath(primPath), "defaultRender");
    }

    emscripten::val DrawSubtree(
        const std::string& primPath,
        const std::string& purposePolicy)
    {
        return _Draw(true, SdfPath(primPath), purposePolicy);
    }

private:
    void RebuildDriverStage()
    {
        _driverSession->Clear();
        _driverSession->SetSubLayerPaths(
            { _inspectionStage->GetSessionLayer()->GetIdentifier() });
        if (!_driverStage) {
            _driverStage = UsdStage::Open(
                _inspectionStage->GetRootLayer(), _driverSession);
        }
        if (!_driverStage) {
            return;
        }
        _driverStage->SetLoadRules(_inspectionStage->GetLoadRules());
        _driverStage->SetEditTarget(UsdEditTarget(_driverSession));
        _topologyByPath.clear();

        const bool sessionDirtyBefore =
            _inspectionStage->GetSessionLayer()->IsDirty();

        bool hasSkelContent = false;
        for (const UsdPrim& prim : _driverStage->Traverse()) {
            if (prim.IsA<UsdSkelRoot>()) {
                hasSkelContent = true;
                break;
            }
        }

        _inferredBindingCount = 0;
        _bakeTimeMs = 0.0;
        if (hasSkelContent) {
            LegacySkelBindingAuthoringDiagnostics inferenceDiagnostics;
            _inferredBindingCount = _AuthorInferredSkelBindingTargetsToLayer(
                _driverStage, _driverSession, &inferenceDiagnostics);

            // UsdSkelBakeSkinning resolves bindings through
            // ComputeSkelBindings, which requires SkelBindingAPI to be
            // applied — inferred relationships alone are not enough. Apply
            // it (into the driver session via the edit target) wherever a
            // skel:skeleton relationship is composed without the schema.
            for (const UsdPrim& prim : _driverStage->Traverse()) {
                if (prim.HasAPI<UsdSkelBindingAPI>()) {
                    continue;
                }
                auto hasRelTargets = [&prim](const TfToken& relName) {
                    UsdRelationship rel = prim.GetRelationship(relName);
                    SdfPathVector targets;
                    return rel && rel.GetTargets(&targets) && !targets.empty();
                };
                if (hasRelTargets(UsdSkelTokens->skelSkeleton) ||
                    hasRelTargets(UsdSkelTokens->skelAnimationSource)) {
                    UsdSkelBindingAPI::Apply(prim);
                }
            }

            const auto bakeStart = std::chrono::steady_clock::now();
            UsdSkelBakeSkinning(_driverStage->Traverse());
            _bakeTimeMs = std::chrono::duration<double, std::milli>(
                std::chrono::steady_clock::now() - bakeStart).count();
        }
        _rootLayerCleanAfterBake = !_inspectionStage->GetRootLayer()->IsDirty();
        _inspectionSessionCleanAfterBake =
            _inspectionStage->GetSessionLayer()->IsDirty() == sessionDirtyBefore;

        _ComputeCapabilities(hasSkelContent);
    }

    void _ComputeCapabilities(bool hasSkelContent)
    {
        _capabilities = StageDriverCapabilities();
        _timeVaryingPrimPaths.clear();
        _capabilities.hasSkelContent = hasSkelContent;
        _capabilities.skelBindingsInferred = _inferredBindingCount > 0;
        _capabilities.hasAnimationRange =
            _driverStage->GetEndTimeCode() > _driverStage->GetStartTimeCode();

        static const TfToken kSplatType("ParticleField3DGaussianSplat");
        for (const UsdPrim& prim : _driverStage->Traverse()) {
            if (prim.GetTypeName() == kSplatType) {
                _capabilities.hasGaussianSplats = true;
            }
            if (prim.IsA<UsdGeomPointInstancer>()) {
                _capabilities.hasPointInstancers = true;
            }
            if (prim.IsA<UsdGeomMesh>()) {
                UsdGeomMesh mesh(prim);
                bool primTimeVarying = false;
                UsdAttribute pointsAttr = mesh.GetPointsAttr();
                if (pointsAttr && pointsAttr.GetNumTimeSamples() > 1) {
                    _capabilities.hasTimeVaryingPoints = true;
                    primTimeVarying = true;
                }
                // A mesh moves when any ancestor xform varies, so probe the
                // whole path, not just the prim's own ops.
                for (UsdPrim ancestor = prim;
                     ancestor && !ancestor.IsPseudoRoot();
                     ancestor = ancestor.GetParent()) {
                    UsdGeomXformable xformable(ancestor);
                    if (!xformable) {
                        continue;
                    }
                    bool resetsStack = false;
                    bool varies = false;
                    for (const UsdGeomXformOp& op :
                         xformable.GetOrderedXformOps(&resetsStack)) {
                        if (op.GetNumTimeSamples() > 1) {
                            varies = true;
                            break;
                        }
                    }
                    if (varies) {
                        _capabilities.hasTimeVaryingXforms = true;
                        primTimeVarying = true;
                        break;
                    }
                }
                if (primTimeVarying) {
                    _timeVaryingPrimPaths.insert(prim.GetPath().GetString());
                }
            }
            if (prim.IsA<UsdShadeShader>()) {
                SdfAssetPath sourceAsset;
                TfToken subIdentifier;
                if (_GetMaterialXSourceAsset(
                        UsdShadeShader(prim), &sourceAsset, &subIdentifier)) {
                    _capabilities.hasMaterialX = true;
                }
            }
        }
    }

    struct TriangulatedTopology
    {
        VtVec3iArray triangleIndices;
        VtIntArray primitiveParams;
        VtIntArray faceVertexCounts;
        VtIntArray faceVertexIndices;
        size_t pointBasis = 0;
    };

    const TriangulatedTopology* _GetTopology(const UsdGeomMesh& mesh)
    {
        const std::string path = mesh.GetPath().GetString();
        auto it = _topologyByPath.find(path);
        if (it != _topologyByPath.end()) {
            return &it->second;
        }

        TriangulatedTopology topo;
        mesh.GetFaceVertexCountsAttr().Get(&topo.faceVertexCounts);
        mesh.GetFaceVertexIndicesAttr().Get(&topo.faceVertexIndices);
        if (topo.faceVertexCounts.empty() || topo.faceVertexIndices.empty()) {
            return nullptr;
        }
        HdMeshTopology topology(
            PxOsdOpenSubdivTokens->none,
            HdTokens->rightHanded,
            topo.faceVertexCounts,
            topo.faceVertexIndices);
        HdMeshUtil meshUtil(&topology, mesh.GetPath());
        meshUtil.ComputeTriangleIndices(
            &topo.triangleIndices, &topo.primitiveParams);
        if (topo.triangleIndices.empty()) {
            return nullptr;
        }
        auto inserted = _topologyByPath.emplace(path, std::move(topo));
        return &inserted.first->second;
    }

    // Sample a vec3f/vec2f primvar and return per-triangle-corner expanded
    // floats, honoring faceVarying / vertex / uniform / constant interpolation.
    template <typename VecType>
    bool _ExpandPrimvarToCorners(
        const UsdGeomPrimvar& primvar,
        const TriangulatedTopology& topo,
        const std::vector<int>& triangleOrder,
        UsdTimeCode timeCode,
        int components,
        std::vector<float>* out) const
    {
        VtArray<VecType> values;
        if (!primvar || !primvar.ComputeFlattened(&values, timeCode) ||
            values.empty()) {
            return false;
        }
        const TfToken interpolation = primvar.GetInterpolation();
        const size_t cornerCount = topo.triangleIndices.size() * 3;
        out->clear();
        out->reserve(cornerCount * components);

        auto pushValue = [&](size_t index) {
            const VecType& v = values[std::min(index, values.size() - 1)];
            for (int c = 0; c < components; ++c) {
                out->push_back(float(v[c]));
            }
        };

        if (interpolation == UsdGeomTokens->faceVarying) {
            // Triangulate authored-corner data with HdMeshUtil so corner
            // order matches ComputeTriangleIndices.
            HdMeshTopology topology(
                PxOsdOpenSubdivTokens->none,
                HdTokens->rightHanded,
                topo.faceVertexCounts,
                topo.faceVertexIndices);
            HdMeshUtil meshUtil(&topology, SdfPath::AbsoluteRootPath());
            VtValue triangulated;
            if (meshUtil.ComputeTriangulatedFaceVaryingPrimvar(
                    values.cdata(),
                    static_cast<int>(values.size()),
                    components == 2 ? HdTypeFloatVec2 : HdTypeFloatVec3,
                    &triangulated) != HdMeshComputationResult::Success) {
                return _ExpandFlattenedFaceVaryingPrimvarToCorners(
                    values, topo, triangleOrder, components, out);
            }
            if (!triangulated.IsHolding<VtArray<VecType>>()) {
                return _ExpandFlattenedFaceVaryingPrimvarToCorners(
                    values, topo, triangleOrder, components, out);
            }
            const VtArray<VecType> cornerValues =
                triangulated.Get<VtArray<VecType>>();
            if (cornerValues.empty()) {
                return _ExpandFlattenedFaceVaryingPrimvarToCorners(
                    values, topo, triangleOrder, components, out);
            }
            for (int tri : triangleOrder) {
                for (int corner = 0; corner < 3; ++corner) {
                    const size_t index = std::min(
                        size_t(tri) * 3 + corner, cornerValues.size() - 1);
                    const VecType& v = cornerValues[index];
                    for (int c = 0; c < components; ++c) {
                        out->push_back(float(v[c]));
                    }
                }
            }
            return true;
        }

        if (interpolation == UsdGeomTokens->vertex ||
            interpolation == UsdGeomTokens->varying) {
            for (int tri : triangleOrder) {
                const GfVec3i& triangle = topo.triangleIndices[tri];
                for (int corner = 0; corner < 3; ++corner) {
                    pushValue(size_t(triangle[corner]));
                }
            }
            return true;
        }

        if (interpolation == UsdGeomTokens->uniform) {
            for (int tri : triangleOrder) {
                const size_t face = size_t(HdMeshUtil::DecodeFaceIndexFromCoarseFaceParam(
                    topo.primitiveParams[tri]));
                for (int corner = 0; corner < 3; ++corner) {
                    pushValue(face);
                }
            }
            return true;
        }

        // constant
        for (size_t i = 0; i < topo.triangleIndices.size() * 3; ++i) {
            pushValue(0);
        }
        return true;
    }

    template <typename VecType>
    bool _ExpandFlattenedFaceVaryingPrimvarToCorners(
        const VtArray<VecType>& values,
        const TriangulatedTopology& topo,
        const std::vector<int>& triangleOrder,
        int components,
        std::vector<float>* out) const
    {
        if (values.size() != topo.faceVertexIndices.size()) {
            return false;
        }

        std::vector<size_t> faceStart;
        faceStart.reserve(topo.faceVertexCounts.size());
        size_t offset = 0;
        for (int count : topo.faceVertexCounts) {
            faceStart.push_back(offset);
            offset += size_t(std::max(count, 0));
        }

        out->clear();
        out->reserve(triangleOrder.size() * 3 * components);
        for (int tri : triangleOrder) {
            const size_t face = size_t(HdMeshUtil::DecodeFaceIndexFromCoarseFaceParam(
                topo.primitiveParams[tri]));
            if (face >= faceStart.size()) {
                return false;
            }
            const size_t start = faceStart[face];
            const size_t count = size_t(topo.faceVertexCounts[face]);
            const GfVec3i& triangle = topo.triangleIndices[tri];
            for (int corner = 0; corner < 3; ++corner) {
                const int pointIndex = triangle[corner];
                size_t valueIndex = start;
                for (size_t local = 0; local < count; ++local) {
                    if (topo.faceVertexIndices[start + local] == pointIndex) {
                        valueIndex = start + local;
                        break;
                    }
                }
                const VecType& value = values[std::min(valueIndex, values.size() - 1)];
                for (int c = 0; c < components; ++c) {
                    out->push_back(float(value[c]));
                }
            }
        }
        return !out->empty();
    }

    bool _PurposeIsIncluded(const TfToken& purpose, const std::string& policy) const
    {
        if (policy == "all") {
            return true;
        }
        if (policy == "proxy") {
            return purpose == UsdGeomTokens->proxy;
        }
        if (policy == "render") {
            return purpose == UsdGeomTokens->render;
        }
        return purpose == UsdGeomTokens->default_ ||
            purpose == UsdGeomTokens->render;
    }

    emscripten::val _Draw(
        bool full,
        const SdfPath& rootPath,
        const std::string& purposePolicy)
    {
        emscripten::val result = emscripten::val::object();
        emscripten::val meshes = emscripten::val::array();
        size_t meshIndex = 0;
        if (!_driverStage) {
            result.set("meshes", meshes);
            return result;
        }

        const UsdTimeCode timeCode(_timeCode);
        UsdGeomXformCache xformCache(timeCode);
        UsdShadeMaterialBindingAPI::BindingsCache bindingsCache;
        UsdShadeMaterialBindingAPI::CollectionQueryCache collectionQueryCache;
        const std::vector<SdfPath> instancerPrototypeRoots =
            _CollectPointInstancerPrototypeRoots(_driverStage);

        for (const UsdPrim& prim : _driverStage->Traverse()) {
            if (!prim.IsA<UsdGeomMesh>()) {
                continue;
            }
            if (rootPath != SdfPath::AbsoluteRootPath() &&
                !prim.GetPath().HasPrefix(rootPath)) {
                continue;
            }
            if (_PathHasPrefixInList(prim.GetPath(), instancerPrototypeRoots)) {
                continue;
            }
            UsdGeomImageable imageable(prim);
            if (imageable.ComputeVisibility(timeCode) ==
                UsdGeomTokens->invisible) {
                continue;
            }
            const TfToken purpose = imageable.ComputePurpose();
            if (!_PurposeIsIncluded(purpose, purposePolicy)) {
                continue;
            }

            if (!full &&
                _timeVaryingPrimPaths.find(prim.GetPath().GetString()) ==
                    _timeVaryingPrimPaths.end()) {
                continue;
            }
            UsdGeomMesh mesh(prim);

            emscripten::val entry =
                _BuildMeshEntry(mesh, timeCode, xformCache,
                                bindingsCache, collectionQueryCache);
            if (!entry.isUndefined()) {
                meshes.set(meshIndex++, entry);
            }
        }

        // Point instancers reuse the legacy extraction path; entries carry
        // points+indices (unexpanded) and instanceMatrices, which the TS
        // consumer expands.
        if (full || _capabilities.hasPointInstancers) {
            const std::string packageRootPath =
                _GetLayerIdentifier(_driverStage->GetRootLayer());
            _AppendPointInstancerRenderablesAtTime(
                &meshes,
                &meshIndex,
                _stagePath,
                _driverStage,
                packageRootPath,
                timeCode,
                /* includeMaterials = */ true,
                rootPath,
                instancerPrototypeRoots,
                /* skelCache = */ nullptr,
                &bindingsCache,
                &collectionQueryCache);
        }

        result.set("meshes", meshes);
        return result;
    }

    emscripten::val _BuildMeshEntry(
        const UsdGeomMesh& mesh,
        UsdTimeCode timeCode,
        UsdGeomXformCache& xformCache,
        UsdShadeMaterialBindingAPI::BindingsCache& bindingsCache,
        UsdShadeMaterialBindingAPI::CollectionQueryCache& collectionQueryCache)
    {
        const TriangulatedTopology* topo = _GetTopology(mesh);
        if (!topo) {
            return emscripten::val::undefined();
        }
        VtArray<GfVec3f> points = _GetMeshPointsAsFloat(mesh, timeCode);
        if (points.empty()) {
            return emscripten::val::undefined();
        }

        const UsdPrim prim = mesh.GetPrim();
        emscripten::val entry = emscripten::val::object();
        entry.set("path", prim.GetPath().GetString());
        entry.set("name", prim.GetName().GetString());

        // Subset-aware triangle emission order: group triangles per bound
        // GeomSubset so material groups are contiguous [start,count) ranges.
        const size_t triangleCount = topo->triangleIndices.size();
        std::vector<int> triangleOrder(triangleCount);
        for (size_t i = 0; i < triangleCount; ++i) {
            triangleOrder[i] = int(i);
        }

        emscripten::val subsets = emscripten::val::array();
        bool hasSubsets = false;
        {
            const std::vector<UsdGeomSubset> geomSubsets =
                UsdGeomSubset::GetGeomSubsets(
                    UsdGeomImageable(prim),
                    UsdGeomTokens->face,
                    TfToken("materialBind"));
            if (!geomSubsets.empty()) {
                // face index -> subset slot (last one wins, like Hydra)
                std::unordered_map<int, int> subsetByFace;
                for (size_t s = 0; s < geomSubsets.size(); ++s) {
                    VtIntArray faceIndices;
                    geomSubsets[s].GetIndicesAttr().Get(&faceIndices, timeCode);
                    for (int face : faceIndices) {
                        subsetByFace[face] = int(s);
                    }
                }
                // stable partition triangles: subset 0..n-1, then unassigned
                std::vector<std::vector<int>> bySlot(geomSubsets.size() + 1);
                for (size_t tri = 0; tri < triangleCount; ++tri) {
                    const int face =
                        HdMeshUtil::DecodeFaceIndexFromCoarseFaceParam(
                            topo->primitiveParams[tri]);
                    auto slotIt = subsetByFace.find(face);
                    bySlot[slotIt == subsetByFace.end()
                        ? geomSubsets.size()
                        : size_t(slotIt->second)].push_back(int(tri));
                }
                triangleOrder.clear();
                size_t subsetIndex = 0;
                for (size_t s = 0; s < geomSubsets.size(); ++s) {
                    if (bySlot[s].empty()) {
                        continue;
                    }
                    emscripten::val subset = emscripten::val::object();
                    subset.set("path", geomSubsets[s].GetPath().GetString());
                    subset.set("name", geomSubsets[s].GetPrim().GetName().GetString());
                    subset.set("start", int(triangleOrder.size() * 3));
                    subset.set("count", int(bySlot[s].size() * 3));
                    UsdShadeMaterialBindingAPI subsetBinding(
                        geomSubsets[s].GetPrim());
                    UsdShadeMaterial subsetMaterial =
                        subsetBinding.ComputeBoundMaterial(
                            &bindingsCache, &collectionQueryCache);
                    if (subsetMaterial) {
                        subset.set(
                            "materialPath",
                            subsetMaterial.GetPath().GetString());
                    }
                    subsets.set(subsetIndex++, subset);
                    triangleOrder.insert(
                        triangleOrder.end(), bySlot[s].begin(), bySlot[s].end());
                    hasSubsets = true;
                }
                if (!bySlot.back().empty()) {
                    emscripten::val subset = emscripten::val::object();
                    subset.set("path", prim.GetPath().GetString());
                    subset.set("name", prim.GetName().GetString());
                    subset.set("start", int(triangleOrder.size() * 3));
                    subset.set("count", int(bySlot.back().size() * 3));
                    subsets.set(subsetIndex++, subset);
                    triangleOrder.insert(
                        triangleOrder.end(),
                        bySlot.back().begin(), bySlot.back().end());
                }
            }
        }

        // Positions: triangle-corner expanded.
        std::vector<float> positions;
        positions.reserve(triangleCount * 9);
        for (int tri : triangleOrder) {
            const GfVec3i& triangle = topo->triangleIndices[tri];
            for (int corner = 0; corner < 3; ++corner) {
                const size_t pointIndex = size_t(triangle[corner]);
                if (pointIndex >= points.size()) {
                    // skip-the-face error handling: emit a degenerate corner
                    positions.push_back(0);
                    positions.push_back(0);
                    positions.push_back(0);
                    continue;
                }
                const GfVec3f& p = points[pointIndex];
                positions.push_back(p[0]);
                positions.push_back(p[1]);
                positions.push_back(p[2]);
            }
        }
        // Copy into a JS-owned array before continuing the draw.  With
        // ALLOW_MEMORY_GROWTH, a later native allocation can replace the
        // WASM heap buffer and detach any typed-memory views created earlier
        // in this same draw.
        entry.set("positions", _Float32Array(positions));

        // Normals: authored first (primvars:normals wins over normals attr),
        // natively computed smooth normals as fallback.
        std::vector<float> normals;
        bool haveNormals = false;
        UsdGeomPrimvarsAPI primvarsApi(prim);
        UsdGeomPrimvar normalsPrimvar =
            primvarsApi.GetPrimvar(TfToken("normals"));
        if (normalsPrimvar) {
            haveNormals = _ExpandPrimvarToCorners<GfVec3f>(
                normalsPrimvar, *topo, triangleOrder, timeCode, 3, &normals);
        }
        if (!haveNormals) {
            VtArray<GfVec3f> authoredNormals;
            if (mesh.GetNormalsAttr().Get(&authoredNormals, timeCode) &&
                !authoredNormals.empty()) {
                const TfToken interpolation = mesh.GetNormalsInterpolation();
                haveNormals = _ExpandValuesToCorners(
                    authoredNormals, interpolation, *topo, triangleOrder,
                    &normals);
            }
        }
        if (!haveNormals) {
            HdMeshTopology topology(
                PxOsdOpenSubdivTokens->none,
                HdTokens->rightHanded,
                topo->faceVertexCounts,
                topo->faceVertexIndices);
            Hd_VertexAdjacency adjacency;
            adjacency.BuildAdjacencyTable(&topology);
            VtArray<GfVec3f> smooth = Hd_SmoothNormals::ComputeSmoothNormals(
                &adjacency,
                static_cast<int>(points.size()),
                points.cdata());
            if (!smooth.empty()) {
                haveNormals = _ExpandValuesToCorners(
                    smooth, UsdGeomTokens->vertex, *topo, triangleOrder,
                    &normals);
            }
        }
        if (haveNormals) {
            entry.set("normals", _Float32Array(normals));
        }

        // UVs (primvars:st), same corner stream.
        std::vector<float> uvs;
        UsdGeomPrimvar stPrimvar = primvarsApi.GetPrimvar(TfToken("st"));
        if (stPrimvar &&
            _ExpandPrimvarToCorners<GfVec2f>(
                stPrimvar, *topo, triangleOrder, timeCode, 2, &uvs)) {
            entry.set("uvs", _Float32Array(uvs));
        }

        entry.set(
            "matrix",
            _MatrixArray(xformCache.GetLocalToWorldTransform(prim)));

        VtArray<GfVec3f> displayColors;
        if (mesh.GetDisplayColorAttr().Get(&displayColors, timeCode) &&
            !displayColors.empty()) {
            entry.set("displayColor", _Vec3Array(displayColors[0]));
        }

        UsdShadeMaterial boundMaterial =
            UsdShadeMaterialBindingAPI(prim).ComputeBoundMaterial(
                &bindingsCache, &collectionQueryCache);
        if (!boundMaterial) {
            if (UsdPrim materialPrim =
                    _FindBoundMaterialPrimByAuthoredRelationships(prim)) {
                entry.set("materialPath", materialPrim.GetPath().GetString());
            }
        } else {
            entry.set("materialPath", boundMaterial.GetPath().GetString());
        }

        if (hasSubsets) {
            entry.set("subsets", subsets);
        }
        return entry;
    }

    bool _ExpandValuesToCorners(
        const VtArray<GfVec3f>& values,
        const TfToken& interpolation,
        const TriangulatedTopology& topo,
        const std::vector<int>& triangleOrder,
        std::vector<float>* out) const
    {
        out->clear();
        out->reserve(triangleOrder.size() * 9);
        auto push = [&](size_t index) {
            const GfVec3f& v = values[std::min(index, values.size() - 1)];
            out->push_back(v[0]);
            out->push_back(v[1]);
            out->push_back(v[2]);
        };

        if (interpolation == UsdGeomTokens->faceVarying) {
            HdMeshTopology topology(
                PxOsdOpenSubdivTokens->none,
                HdTokens->rightHanded,
                topo.faceVertexCounts,
                topo.faceVertexIndices);
            HdMeshUtil meshUtil(&topology, SdfPath::AbsoluteRootPath());
            VtValue triangulated;
            if (meshUtil.ComputeTriangulatedFaceVaryingPrimvar(
                    values.cdata(),
                    static_cast<int>(values.size()),
                    HdTypeFloatVec3,
                    &triangulated) != HdMeshComputationResult::Success) {
                return false;
            }
            const VtArray<GfVec3f> corners =
                triangulated.Get<VtArray<GfVec3f>>();
            for (int tri : triangleOrder) {
                for (int corner = 0; corner < 3; ++corner) {
                    const size_t index = std::min(
                        size_t(tri) * 3 + corner, corners.size() - 1);
                    const GfVec3f& v = corners[index];
                    out->push_back(v[0]);
                    out->push_back(v[1]);
                    out->push_back(v[2]);
                }
            }
            return true;
        }
        if (interpolation == UsdGeomTokens->vertex ||
            interpolation == UsdGeomTokens->varying) {
            for (int tri : triangleOrder) {
                const GfVec3i& triangle = topo.triangleIndices[tri];
                for (int corner = 0; corner < 3; ++corner) {
                    push(size_t(triangle[corner]));
                }
            }
            return true;
        }
        if (interpolation == UsdGeomTokens->uniform) {
            for (int tri : triangleOrder) {
                const size_t face = size_t(
                    HdMeshUtil::DecodeFaceIndexFromCoarseFaceParam(
                        topo.primitiveParams[tri]));
                for (int corner = 0; corner < 3; ++corner) {
                    push(face);
                }
            }
            return true;
        }
        for (size_t i = 0; i < triangleOrder.size() * 3; ++i) {
            push(0);
        }
        return true;
    }

    std::string _stagePath;
    UsdStageRefPtr _inspectionStage;
    UsdStageRefPtr _driverStage;
    SdfLayerRefPtr _driverSession;
    double _timeCode = 0.0;
    StageDriverCapabilities _capabilities;
    int _inferredBindingCount = 0;
    double _bakeTimeMs = 0.0;
    bool _rootLayerCleanAfterBake = true;
    bool _inspectionSessionCleanAfterBake = true;
    std::unordered_map<std::string, TriangulatedTopology> _topologyByPath;
    std::set<std::string> _timeVaryingPrimPaths;
};

std::unordered_map<std::string, std::unique_ptr<WebViewStageDriver>>
    g_unifiedDrivers;

WebViewStageDriver*
_GetUnifiedDriver(const std::string& stagePath)
{
    auto it = g_unifiedDrivers.find(stagePath);
    return it != g_unifiedDrivers.end() ? it->second.get() : nullptr;
}

// --- Unified stage driver bindings (Phase 3) ---

bool
CreateStageDriver(const std::string& stagePath)
{
    auto driver = std::make_unique<WebViewStageDriver>(stagePath);
    if (!driver->IsValid()) {
        return false;
    }
    g_unifiedDrivers[stagePath] = std::move(driver);
    return true;
}

void
DeleteStageDriver(const std::string& stagePath)
{
    g_unifiedDrivers.erase(stagePath);
}

void
StageDriverSetTime(const std::string& stagePath, double timeCode)
{
    if (WebViewStageDriver* driver = _GetUnifiedDriver(stagePath)) {
        driver->SetTime(timeCode);
    }
}

emscripten::val
StageDriverDraw(
    const std::string& stagePath,
    bool full,
    const std::string& purposePolicy)
{
    WebViewStageDriver* driver = _GetUnifiedDriver(stagePath);
    return driver ? driver->Draw(full, purposePolicy) : emscripten::val::undefined();
}

emscripten::val
StageDriverDrawSubtree(
    const std::string& stagePath,
    const std::string& primPath,
    const std::string& purposePolicy)
{
    WebViewStageDriver* driver = _GetUnifiedDriver(stagePath);
    return driver ? driver->DrawSubtree(primPath, purposePolicy) : emscripten::val::undefined();
}

emscripten::val
StageDriverGetTiming(const std::string& stagePath)
{
    emscripten::val timing = emscripten::val::object();
    if (WebViewStageDriver* driver = _GetUnifiedDriver(stagePath)) {
        timing.set("start", driver->GetStartTimeCode());
        timing.set("end", driver->GetEndTimeCode());
        timing.set("fps", driver->GetTimeCodesPerSecond());
    }
    return timing;
}

emscripten::val
StageDriverGetCapabilities(const std::string& stagePath)
{
    WebViewStageDriver* driver = _GetUnifiedDriver(stagePath);
    return driver ? driver->GetCapabilities() : emscripten::val::undefined();
}

emscripten::val
StageDriverGetDiagnostics(const std::string& stagePath)
{
    WebViewStageDriver* driver = _GetUnifiedDriver(stagePath);
    return driver ? driver->GetDiagnostics() : emscripten::val::undefined();
}

void
StageDriverNotifyStageEdited(const std::string& stagePath)
{
    if (WebViewStageDriver* driver = _GetUnifiedDriver(stagePath)) {
        driver->NotifyStageEdited();
    }
}

} // namespace usdwebview
