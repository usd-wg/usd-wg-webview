#include "webviewCommon.h"

namespace usdwebview {

bool
_RelationshipNameLooksLikeMaterialBinding(const TfToken& name)
{
    return TfStringStartsWith(name.GetString(), "material:binding");
}

// Reads raw relationship targets directly from SDF layers, bypassing USD's
// composed relationship API. Necessary for older USDZ files where the
// material:binding relationship was authored without an applied API schema,
// which causes GetTargets()/GetForwardedTargets() to return empty in USD 26+.
SdfPathVector
_GetRelationshipTargetsFromLayers(const UsdPrim& prim, const TfToken& relName)
{
    const SdfPath relPath = prim.GetPath().AppendProperty(relName);

    auto tryLayer = [&](const SdfLayerHandle& layer) -> SdfPathVector {
        if (!layer) return {};
        SdfRelationshipSpecHandle relSpec = TfDynamic_cast<SdfRelationshipSpecHandle>(
            layer->GetObjectAtPath(relPath));
        if (!relSpec) return {};
        const SdfTargetsProxy& proxy = relSpec->GetTargetPathList();
        for (const SdfPath& path : proxy.GetExplicitItems())   { return { path }; }
        for (const SdfPath& path : proxy.GetPrependedItems())  { return { path }; }
        for (const SdfPath& path : proxy.GetAppendedItems())   { return { path }; }
        for (const SdfPath& path : proxy.GetAddedItems())      { return { path }; }
        return {};
    };

    // Try every layer the stage knows about
    for (const SdfLayerHandle& layer : prim.GetStage()->GetUsedLayers(true)) {
        SdfPathVector result = tryLayer(layer);
        if (!result.empty()) return result;
    }
    return {};
}

SdfPathVector
_GetMaterialBindingTargets(const UsdPrim& bindingPrim, const UsdRelationship& relationship)
{
    SdfPathVector targets;
    if (!relationship.GetForwardedTargets(&targets) || targets.empty()) {
        targets.clear();
        relationship.GetTargets(&targets);
    }
    if (targets.empty()) {
        targets = _GetRelationshipTargetsFromLayers(bindingPrim, relationship.GetName());
    }
    return targets;
}

TfToken
_GetMaterialBindingStrength(const UsdRelationship& relationship)
{
    TfToken bindingStrength;
    relationship.GetMetadata(UsdShadeTokens->bindMaterialAs, &bindingStrength);
    return bindingStrength.IsEmpty()
        ? UsdShadeTokens->weakerThanDescendants
        : bindingStrength;
}

// Scan the stage for Material prims under the same root as the binding prim.
// Used as last resort when relationship targets are invisible to the USD API.
UsdPrim
_FindMaterialPrimByStageTraversal(const UsdPrim& bindingPrim)
{
    UsdStageWeakPtr stage = bindingPrim.GetStage();
    const std::string bindingRoot = bindingPrim.GetPath().GetPrefixes().front().GetString();

    // First pass: prefer materials under the same hierarchy root
    for (const UsdPrim& p : UsdPrimRange(stage->GetPseudoRoot())) {
        if (!p.IsA<UsdShadeMaterial>()) continue;
        if (TfStringStartsWith(p.GetPath().GetString(), bindingRoot)) {
            return p;
        }
    }
    // Second pass: any material prim on the stage
    for (const UsdPrim& p : UsdPrimRange(stage->GetPseudoRoot())) {
        if (p.IsA<UsdShadeMaterial>()) return p;
    }
    return UsdPrim();
}

UsdShadeMaterial
_FindBoundMaterialByAuthoredRelationships(const UsdPrim& prim)
{
    UsdStageWeakPtr stage = prim.GetStage();
    UsdShadeMaterial weakestDescendantMaterial;
    for (UsdPrim bindingPrim = prim; bindingPrim && !bindingPrim.IsPseudoRoot();
         bindingPrim = bindingPrim.GetParent()) {
        for (const UsdRelationship& relationship : bindingPrim.GetRelationships()) {
            if (!_RelationshipNameLooksLikeMaterialBinding(relationship.GetName())) {
                continue;
            }

            for (const SdfPath& target :
                 _GetMaterialBindingTargets(bindingPrim, relationship)) {
                const SdfPath materialPath = target.IsPrimPath() ? target : target.GetPrimPath();
                UsdShadeMaterial material(stage->GetPrimAtPath(materialPath));
                if (material) {
                    if (_GetMaterialBindingStrength(relationship) ==
                        UsdShadeTokens->strongerThanDescendants) {
                        return material;
                    }
                    if (!weakestDescendantMaterial) {
                        weakestDescendantMaterial = material;
                    }
                }
            }
        }
    }

    return weakestDescendantMaterial;
}

UsdPrim
_FindBoundMaterialPrimByAuthoredRelationships(const UsdPrim& prim)
{
    UsdStageWeakPtr stage = prim.GetStage();
    UsdPrim weakestDescendantMaterialPrim;
    for (UsdPrim bindingPrim = prim; bindingPrim && !bindingPrim.IsPseudoRoot();
         bindingPrim = bindingPrim.GetParent()) {
        for (const UsdRelationship& relationship : bindingPrim.GetRelationships()) {
            if (!_RelationshipNameLooksLikeMaterialBinding(relationship.GetName())) {
                continue;
            }

            for (const SdfPath& target :
                 _GetMaterialBindingTargets(bindingPrim, relationship)) {
                const SdfPath materialPath = target.IsPrimPath() ? target : target.GetPrimPath();
                UsdPrim materialPrim = stage->GetPrimAtPath(materialPath);
                if (materialPrim) {
                    if (_GetMaterialBindingStrength(relationship) ==
                        UsdShadeTokens->strongerThanDescendants) {
                        return materialPrim;
                    }
                    if (!weakestDescendantMaterialPrim) {
                        weakestDescendantMaterialPrim = materialPrim;
                    }
                }
            }
        }
    }

    if (weakestDescendantMaterialPrim) {
        return weakestDescendantMaterialPrim;
    }

    // All relationship APIs failed — scan stage for Material prims.
    // Handles USD 26+ schema changes that make pre-schema material:binding invisible.
    return _FindMaterialPrimByStageTraversal(prim);
}

emscripten::val
_ColorArray(const UsdGeomMesh& mesh)
{
    VtArray<GfVec3f> colors;
    if (!UsdGeomGprim(mesh).GetDisplayColorAttr().Get(&colors) || colors.empty()) {
        colors.push_back(GfVec3f(0.72f, 0.72f, 0.72f));
    }

    emscripten::val array = emscripten::val::array();
    array.set(0, colors[0][0]);
    array.set(1, colors[0][1]);
    array.set(2, colors[0][2]);
    return array;
}

std::string
_GetMimeType(const std::string& path)
{
    // For USDZ package-relative paths like "file.usdz[inner/texture.jpg]"
    // the extension must be read from the inner path, not the outer one.
    std::string effectivePath = path;
    const size_t openBracket = path.rfind('[');
    if (openBracket != std::string::npos) {
        const size_t closeBracket = path.rfind(']');
        if (closeBracket > openBracket) {
            effectivePath = path.substr(openBracket + 1, closeBracket - openBracket - 1);
        }
    }

    const std::string extension = TfStringToLower(TfGetExtension(effectivePath));
    if (extension == "jpg" || extension == "jpeg") {
        return "image/jpeg";
    }
    if (extension == "png") {
        return "image/png";
    }
    if (extension == "webp") {
        return "image/webp";
    }
    if (extension == "hdr") {
        return "image/vnd.radiance";
    }
    if (extension == "exr") {
        return "image/x-exr";
    }
    if (extension == "mtlx") {
        return "application/mtlx+xml";
    }
    if (extension == "zip") {
        return "application/zip";
    }
    if (extension == "ktx2") {
        return "image/ktx2";
    }
    return "application/octet-stream";
}

emscripten::val
_ReadTextureAsset(const std::string& path, const std::string& packageRootPath)
{
    emscripten::val texture = emscripten::val::object();
    if (path.empty()) {
        return texture;
    }

    ArResolvedPath resolvedPath = ArGetResolver().Resolve(path);
    std::string resolvedAssetPath = path;
    if (resolvedPath.IsEmpty() && !packageRootPath.empty() && !ArIsPackageRelativePath(path)) {
        resolvedAssetPath = ArJoinPackageRelativePath(packageRootPath, path);
        resolvedPath = ArGetResolver().Resolve(resolvedAssetPath);
    }
    if (resolvedPath.IsEmpty() && ArIsPackageRelativePath(path)) {
        resolvedPath = ArResolvedPath(path);
    }
    if (resolvedPath.IsEmpty()) {
        resolvedPath = ArResolvedPath(resolvedAssetPath);
    }

    std::shared_ptr<ArAsset> asset = ArGetResolver().OpenAsset(resolvedPath);
    if (!asset) {
        return texture;
    }

    std::vector<unsigned char> bytes(asset->GetSize());
    if (!bytes.empty() && asset->Read(bytes.data(), bytes.size(), 0) != bytes.size()) {
        return texture;
    }

    texture.set("path", resolvedAssetPath);
    texture.set("mimeType", _GetMimeType(resolvedAssetPath));
    texture.set("data", _BytesArray(bytes));
    return texture;
}

bool
_IsMaterialXAssetPath(const std::string& path)
{
    const std::string lower = TfStringToLower(path);
    return TfStringEndsWith(lower, ".mtlx") || TfStringEndsWith(lower, ".mtlx.zip");
}

bool
_GetMaterialXSourceAsset(
    const UsdShadeShader& shader,
    SdfAssetPath* sourceAsset,
    TfToken* subIdentifier,
    TfToken* sourceTypeOut)
{
    if (!shader || shader.GetImplementationSource() != UsdShadeTokens->sourceAsset) {
        return false;
    }

    static const TfToken kSourceTypes[] = {
        TfToken(),
        TfToken("mtlx"),
        TfToken("materialx"),
    };

    for (const TfToken& sourceType : kSourceTypes) {
        SdfAssetPath candidate;
        if (!shader.GetSourceAsset(&candidate, sourceType)) {
            continue;
        }

        const std::string candidatePath = !candidate.GetResolvedPath().empty()
            ? candidate.GetResolvedPath()
            : candidate.GetAssetPath();
        if (!_IsMaterialXAssetPath(candidatePath)) {
            continue;
        }

        TfToken candidateSubIdentifier;
        shader.GetSourceAssetSubIdentifier(&candidateSubIdentifier, sourceType);
        *sourceAsset = candidate;
        *subIdentifier = candidateSubIdentifier;
        if (sourceTypeOut) {
            *sourceTypeOut = sourceType;
        }
        return true;
    }

    return false;
}

emscripten::val
_ReadMaterialXAsset(
    const UsdShadeShader& shader,
    const std::string& packageRootPath)
{
    SdfAssetPath sourceAsset;
    TfToken subIdentifier;
    if (!_GetMaterialXSourceAsset(shader, &sourceAsset, &subIdentifier)) {
        return emscripten::val::undefined();
    }

    const std::string rawPath = !sourceAsset.GetResolvedPath().empty()
        ? sourceAsset.GetResolvedPath()
        : sourceAsset.GetAssetPath();
    emscripten::val asset = _ReadTextureAsset(rawPath, packageRootPath);
    if (asset["data"].isUndefined()) {
        return emscripten::val::undefined();
    }

    if (!subIdentifier.IsEmpty()) {
        asset.set("materialName", subIdentifier.GetString());
    }
    return asset;
}

bool
_GetMaterialXReferenceForMaterialPrim(
    const UsdPrim& materialPrim,
    SdfAssetPath* sourceAsset)
{
    if (!materialPrim || !sourceAsset) {
        return false;
    }

    for (UsdPrim prim = materialPrim; prim; prim = prim.GetParent()) {
        const std::vector<SdfPrimSpecHandle>& primStack = prim.GetPrimStack();
        for (const SdfPrimSpecHandle& primSpec : primStack) {
            if (!primSpec) {
                continue;
            }

            const std::vector<SdfReference>& references =
                primSpec->GetReferenceList().GetAppliedItems();
            for (const SdfReference& reference : references) {
                const std::string assetPath = reference.GetAssetPath();
                if (_IsMaterialXAssetPath(assetPath)) {
                    std::string resolvedAssetPath = assetPath;
                    if (SdfLayerHandle layer = primSpec->GetLayer()) {
                        const std::string anchoredAssetPath =
                            layer->ComputeAbsolutePath(assetPath);
                        if (!anchoredAssetPath.empty()) {
                            resolvedAssetPath = anchoredAssetPath;
                        }
                    }
                    *sourceAsset = SdfAssetPath(assetPath, resolvedAssetPath);
                    return true;
                }
            }
        }
    }

    return false;
}

std::string
_XmlEscape(const std::string& value)
{
    std::string result;
    result.reserve(value.size());
    for (char c : value) {
        switch (c) {
            case '&': result += "&amp;"; break;
            case '<': result += "&lt;"; break;
            case '>': result += "&gt;"; break;
            case '"': result += "&quot;"; break;
            case '\'': result += "&apos;"; break;
            default: result += c; break;
        }
    }
    return result;
}

std::string
_MtlxTypeForSdfType(const SdfValueTypeName& typeName)
{
    const std::string type = typeName.GetAsToken().GetString();
    if (type == "color3f") return "color3";
    if (type == "color4f") return "color4";
    if (type == "float2") return "vector2";
    if (type == "float3" || type == "vector3f" || type == "normal3f") return "vector3";
    if (type == "float4" || type == "vector4f") return "vector4";
    if (type == "asset") return "filename";
    if (type == "token" || type == "string") return "string";
    if (type == "int") return "integer";
    return type.empty() ? "float" : type;
}

std::string
_FormatFloat(float value)
{
    std::ostringstream out;
    out << std::setprecision(8) << value;
    return out.str();
}

bool
_PathLooksAbsolute(const std::string& path)
{
    return !path.empty() &&
        (path[0] == '/' ||
         path[0] == '\\' ||
         (path.size() > 2 && std::isalpha(path[0]) && path[1] == ':'));
}

std::string
_FormatMtlxValue(
    const VtValue& value,
    const SdfLayerHandle& anchorLayer)
{
    if (value.IsHolding<float>()) {
        return _FormatFloat(value.UncheckedGet<float>());
    }
    if (value.IsHolding<double>()) {
        std::ostringstream out;
        out << std::setprecision(12) << value.UncheckedGet<double>();
        return out.str();
    }
    if (value.IsHolding<int>()) {
        return std::to_string(value.UncheckedGet<int>());
    }
    if (value.IsHolding<std::string>()) {
        return value.UncheckedGet<std::string>();
    }
    if (value.IsHolding<TfToken>()) {
        return value.UncheckedGet<TfToken>().GetString();
    }
    if (value.IsHolding<SdfAssetPath>()) {
        const SdfAssetPath& asset = value.UncheckedGet<SdfAssetPath>();
        std::string path = !asset.GetResolvedPath().empty()
            ? asset.GetResolvedPath()
            : asset.GetAssetPath();
        if (anchorLayer && !path.empty() && _PathLooksAbsolute(path)) {
            return path;
        }
        if (anchorLayer && !path.empty()) {
            const std::string anchored = anchorLayer->ComputeAbsolutePath(path);
            if (!anchored.empty()) {
                return anchored;
            }
        }
        return path;
    }
    if (value.IsHolding<GfVec2f>()) {
        const GfVec2f& v = value.UncheckedGet<GfVec2f>();
        return _FormatFloat(v[0]) + ", " + _FormatFloat(v[1]);
    }
    if (value.IsHolding<GfVec3f>()) {
        const GfVec3f& v = value.UncheckedGet<GfVec3f>();
        return _FormatFloat(v[0]) + ", " + _FormatFloat(v[1]) + ", " +
            _FormatFloat(v[2]);
    }
    if (value.IsHolding<GfVec4f>()) {
        const GfVec4f& v = value.UncheckedGet<GfVec4f>();
        return _FormatFloat(v[0]) + ", " + _FormatFloat(v[1]) + ", " +
            _FormatFloat(v[2]) + ", " + _FormatFloat(v[3]);
    }
    return std::string();
}

std::string
_MtlxCategoryForShaderId(const TfToken& shaderId)
{
    const std::string id = shaderId.GetString();
    if (id == "ND_standard_surface_surfaceshader") return "standard_surface";
    if (TfStringStartsWith(id, "ND_image_")) return "image";
    if (TfStringStartsWith(id, "ND_saturate_")) return "saturate";
    if (id == "ND_normalmap") return "normalmap";
    if (TfStringStartsWith(id, "ND_UsdPrimvarReader_")) return "geompropvalue";
    if (TfStringStartsWith(id, "ND_")) {
        std::string category = id.substr(3);
        const size_t suffixPos = category.rfind('_');
        if (suffixPos != std::string::npos) {
            const std::string suffix = category.substr(suffixPos + 1);
            if (suffix == "float" || suffix == "color3" || suffix == "color4" ||
                suffix == "vector2" || suffix == "vector3" ||
                suffix == "vector4" || suffix == "surfaceshader") {
                category = category.substr(0, suffixPos);
            }
        }
        return category;
    }
    return id;
}

UsdPrim
_ResolveConnectedPrim(const UsdStageWeakPtr& stage, const SdfPath& target)
{
    if (!stage) {
        return UsdPrim();
    }
    UsdPrim targetPrim = stage->GetPrimAtPath(target.GetPrimPath());
    if (!targetPrim) {
        return UsdPrim();
    }
    if (targetPrim.IsA<UsdShadeShader>()) {
        return targetPrim;
    }

    if (target.IsPropertyPath()) {
        UsdAttribute output = targetPrim.GetAttribute(target.GetNameToken());
        SdfPathVector connections;
        if (output && output.GetConnections(&connections) && !connections.empty()) {
            return _ResolveConnectedPrim(stage, connections[0]);
        }
    }
    return targetPrim.IsA<UsdShadeShader>() ? targetPrim : UsdPrim();
}

UsdPrim
_FindInlineMaterialXSurfaceShaderPrim(const UsdPrim& materialPrim)
{
    static const TfToken preferredSurfaceOutputs[] = {
        TfToken("outputs:mtlx:surface"),
        TfToken("outputs:kma:surface"),
    };

    for (const TfToken& outputName : preferredSurfaceOutputs) {
        UsdAttribute surfaceOutput = materialPrim.GetAttribute(outputName);
        SdfPathVector connections;
        if (surfaceOutput &&
            surfaceOutput.GetConnections(&connections) &&
            !connections.empty()) {
            UsdPrim surfaceShader =
                _ResolveConnectedPrim(materialPrim.GetStage(), connections[0]);
            if (surfaceShader) {
                return surfaceShader;
            }
        }
    }

    for (const UsdAttribute& attr : materialPrim.GetAttributes()) {
        const std::string name = attr.GetName().GetString();
        if (!TfStringStartsWith(name, "outputs:") ||
            !TfStringEndsWith(name, ":surface") ||
            name == "outputs:surface") {
            continue;
        }

        SdfPathVector connections;
        if (!attr.GetConnections(&connections) || connections.empty()) {
            continue;
        }

        UsdPrim surfaceShader =
            _ResolveConnectedPrim(materialPrim.GetStage(), connections[0]);
        if (!surfaceShader) {
            continue;
        }

        TfToken shaderId;
        if (surfaceShader.GetAttribute(TfToken("info:id")).Get(&shaderId) &&
            TfStringStartsWith(shaderId.GetString(), "ND_")) {
            return surfaceShader;
        }
    }

    return UsdPrim();
}

std::string
_InlineMaterialXPath(const UsdPrim& materialPrim)
{
    const std::string filename =
        "__inline_" + materialPrim.GetName().GetString() + ".mtlx";
    for (const SdfPrimSpecHandle& spec : materialPrim.GetPrimStack()) {
        if (!spec || !spec->GetLayer()) {
            continue;
        }
        const std::string path = spec->GetLayer()->ComputeAbsolutePath(filename);
        if (!path.empty()) {
            return path;
        }
    }
    std::string path = materialPrim.GetPath().GetString();
    std::replace(path.begin(), path.end(), '/', '_');
    return "inline:" + path + ".mtlx";
}

SdfLayerHandle
_AnchorLayerForPrim(const UsdPrim& prim)
{
    for (const SdfPrimSpecHandle& spec : prim.GetPrimStack()) {
        if (spec && spec->GetLayer()) {
            return spec->GetLayer();
        }
    }
    return SdfLayerHandle();
}

std::string
_MtlxOutputTypeForShaderPrim(
    const UsdPrim& shaderPrim,
    const std::string& category)
{
    std::string outputType = "float";
    UsdAttribute outAttr = shaderPrim.GetAttribute(TfToken("outputs:out"));
    if (!outAttr) {
        outAttr = shaderPrim.GetAttribute(TfToken("outputs:surface"));
    }
    if (outAttr) {
        outputType = _MtlxTypeForSdfType(outAttr.GetTypeName());
        if (outputType == "token" || outputType == "string") {
            outputType = category == "standard_surface" ? "surfaceshader" : "float";
        }
    }
    return outputType;
}

std::string
_MtlxGraphOutputName(const UsdPrim& shaderPrim)
{
    return shaderPrim.GetName().GetString() + "_out";
}

void
_AppendMtlxInputXml(
    std::ostringstream& xml,
    const UsdPrim& shaderPrim,
    const UsdAttribute& attr,
    const SdfLayerHandle& anchorLayer,
    const UsdPrim& graphRoot = UsdPrim(),
    const std::string& graphName = std::string(),
    bool referenceGraphOutputs = false)
{
    const std::string attrName = attr.GetName().GetString();
    if (!TfStringStartsWith(attrName, "inputs:")) {
        return;
    }

    std::string inputName = attrName.substr(std::string("inputs:").size());
    if (inputName == "texcoord") {
        return;
    }
    if (inputName == "varname") {
        inputName = "geomprop";
    }

    const std::string inputType = _MtlxTypeForSdfType(attr.GetTypeName());
    std::ostringstream inputXml;
    inputXml << "    <input name=\"" << _XmlEscape(inputName)
        << "\" type=\"" << _XmlEscape(inputType) << "\"";
    bool hasPayload = false;

    SdfPathVector connections;
    if (attr.GetConnections(&connections) && !connections.empty()) {
        UsdPrim sourcePrim =
            _ResolveConnectedPrim(shaderPrim.GetStage(), connections[0]);
        if (sourcePrim) {
            if (referenceGraphOutputs &&
                graphRoot && !graphName.empty() &&
                sourcePrim.GetParent() == graphRoot) {
                inputXml << " nodegraph=\"" << _XmlEscape(graphName)
                    << "\" output=\"" << _XmlEscape(_MtlxGraphOutputName(sourcePrim)) << "\"";
            } else {
                inputXml << " nodename=\"" << _XmlEscape(sourcePrim.GetName().GetString()) << "\"";
            }
            hasPayload = true;
            const std::string outputName = connections[0].GetName();
            if (!outputName.empty() &&
                outputName != "outputs:out" &&
                outputName != "out" &&
                outputName != "outputs:result" &&
                !(referenceGraphOutputs &&
                  graphRoot && !graphName.empty() &&
                  sourcePrim.GetParent() == graphRoot)) {
                std::string cleanOutput = outputName;
                if (TfStringStartsWith(cleanOutput, "outputs:")) {
                    cleanOutput = cleanOutput.substr(std::string("outputs:").size());
                }
                inputXml << " output=\"" << _XmlEscape(cleanOutput) << "\"";
            }
        }
    } else {
        VtValue value;
        if (attr.Get(&value) && !value.IsEmpty()) {
            const std::string formatted = _FormatMtlxValue(value, anchorLayer);
            if (!formatted.empty()) {
                inputXml << " value=\"" << _XmlEscape(formatted) << "\"";
                hasPayload = true;
                if (inputType == "filename") {
                    inputXml << " colorspace=\"srgb_texture\"";
                }
            }
        }
    }

    if (!hasPayload) {
        return;
    }
    xml << inputXml.str() << " />\n";
}

emscripten::val
_BuildInlineMaterialXAsset(const UsdPrim& materialPrim)
{
    UsdPrim surfaceShader = _FindInlineMaterialXSurfaceShaderPrim(materialPrim);
    if (!surfaceShader) {
        return emscripten::val::undefined();
    }

    const std::string materialName =
        "M_" + materialPrim.GetName().GetString() + "_inline";
    const SdfLayerHandle anchorLayer = _AnchorLayerForPrim(surfaceShader);
    std::vector<UsdPrim> shaders;
    UsdPrim graphRoot = surfaceShader.GetParent();
    if (!graphRoot) {
        graphRoot = materialPrim ? materialPrim : surfaceShader;
    }
    const std::string graphName =
        "NG_" + materialPrim.GetName().GetString() + "_inline";
    for (const UsdPrim& prim : UsdPrimRange(graphRoot)) {
        if (!prim.IsA<UsdShadeShader>()) {
            continue;
        }
        TfToken shaderId;
        if (!prim.GetAttribute(TfToken("info:id")).Get(&shaderId) ||
            shaderId == TfToken("UsdPreviewSurface")) {
            continue;
        }
        shaders.push_back(prim);
    }
    if (shaders.empty()) {
        shaders.push_back(surfaceShader);
    }

    std::ostringstream xml;
    xml << "<?xml version=\"1.0\"?>\n";
    xml << "<materialx version=\"1.39\" colorspace=\"lin_rec709\">\n";

    std::vector<UsdPrim> orderedShaders;
    orderedShaders.reserve(shaders.size());
    for (const UsdPrim& shaderPrim : shaders) {
        if (shaderPrim != surfaceShader) {
            orderedShaders.push_back(shaderPrim);
        }
    }
    orderedShaders.push_back(surfaceShader);

    for (const UsdPrim& shaderPrim : orderedShaders) {
        TfToken shaderId;
        shaderPrim.GetAttribute(TfToken("info:id")).Get(&shaderId);
        const std::string category = _MtlxCategoryForShaderId(shaderId);
        const std::string outputType = _MtlxOutputTypeForShaderPrim(shaderPrim, category);
        xml << "  <" << category << " name=\""
            << _XmlEscape(shaderPrim.GetName().GetString())
            << "\" type=\"" << _XmlEscape(outputType) << "\">\n";
        for (const UsdAttribute& attr : shaderPrim.GetAttributes()) {
            _AppendMtlxInputXml(
                xml, shaderPrim, attr, anchorLayer, graphRoot, graphName,
                false);
        }
        xml << "  </" << category << ">\n";
    }
    xml << "  <surfacematerial name=\"" << _XmlEscape(materialName)
        << "\" type=\"material\">\n";
    xml << "    <input name=\"surfaceshader\" type=\"surfaceshader\" nodename=\""
        << _XmlEscape(surfaceShader.GetName().GetString()) << "\" />\n";
    xml << "  </surfacematerial>\n";
    xml << "</materialx>\n";

    const std::string text = xml.str();
    std::vector<unsigned char> bytes(text.begin(), text.end());
    emscripten::val asset = emscripten::val::object();
    asset.set("path", _InlineMaterialXPath(materialPrim));
    asset.set("mimeType", "application/mtlx+xml");
    asset.set("materialName", materialName);
    asset.set("data", _BytesArray(bytes));
    return asset;
}

emscripten::val
_ReadMaterialXAssetFromMaterialPrim(
    const UsdPrim& materialPrim,
    const std::string& packageRootPath)
{
    SdfAssetPath sourceAsset;
    if (!_GetMaterialXReferenceForMaterialPrim(materialPrim, &sourceAsset)) {
        return emscripten::val::undefined();
    }

    const std::string rawPath = !sourceAsset.GetResolvedPath().empty()
        ? sourceAsset.GetResolvedPath()
        : sourceAsset.GetAssetPath();
    emscripten::val asset = _ReadTextureAsset(rawPath, packageRootPath);
    if (asset["data"].isUndefined()) {
        return emscripten::val::undefined();
    }

    asset.set("materialName", materialPrim.GetName().GetString());
    return asset;
}

void
_AttachMaterialTextureResources(
    const emscripten::val& materialValue,
    emscripten::val& materialX)
{
    static const char* kTextureKeys[] = {
        "diffuseTexture",
        "roughnessTexture",
        "metallicTexture",
        "normalTexture",
        "occlusionTexture",
        "emissiveTexture",
        "clearcoatTexture",
        "clearcoatRoughnessTexture",
        "opacityTexture",
    };

    emscripten::val resources = emscripten::val::array();
    size_t resourceIndex = 0;
    for (const char* key : kTextureKeys) {
        emscripten::val texture = materialValue[key];
        if (!texture.isUndefined() && !texture["data"].isUndefined()) {
            resources.set(resourceIndex++, texture);
        }
    }

    if (resourceIndex > 0) {
        materialX.set("resources", resources);
    }
}

bool
_GetInputFloat(const UsdShadeShader& shader, const TfToken& name, float* value)
{
    UsdShadeInput input = shader.GetInput(name);
    return input && input.Get(value);
}

bool
_GetInputColor(const UsdShadeShader& shader, const TfToken& name, GfVec3f* value)
{
    UsdShadeInput input = shader.GetInput(name);
    return input && input.Get(value);
}

bool
_GetConnectedTexturePath(const UsdShadeShader& shader, const TfToken& name, std::string* path)
{
    UsdShadeInput input = shader.GetInput(name);
    if (!input) {
        return false;
    }

    UsdShadeConnectableAPI source;
    TfToken sourceName;
    UsdShadeAttributeType sourceType;
    if (!input.GetConnectedSource(&source, &sourceName, &sourceType)) {
        return false;
    }

    UsdShadeShader textureShader(source.GetPrim());
    if (!textureShader) {
        return false;
    }

    SdfAssetPath filePath;
    UsdShadeInput fileInput = textureShader.GetInput(TfToken("file"));
    if (!fileInput || !fileInput.Get(&filePath)) {
        return false;
    }

    *path = !filePath.GetResolvedPath().empty()
        ? filePath.GetResolvedPath()
        : filePath.GetAssetPath();
    return !path->empty();
}

UsdPrim
_GetConnectedSourcePrim(const UsdAttribute& attribute)
{
    SdfPathVector connections;
    if (!attribute || !attribute.GetConnections(&connections) || connections.empty()) {
        return UsdPrim();
    }

    return attribute.GetPrim().GetStage()->GetPrimAtPath(connections[0].GetPrimPath());
}

UsdPrim
_FindSurfaceShaderPrim(const UsdPrim& materialPrim)
{
    // Modern USD: outputs:surface is an attribute with a .connect connection
    UsdAttribute surfaceAttr = materialPrim.GetAttribute(TfToken("outputs:surface"));
    SdfPathVector connections;
    if (surfaceAttr && surfaceAttr.GetConnections(&connections) && !connections.empty()) {
        return materialPrim.GetStage()->GetPrimAtPath(connections[0].GetPrimPath());
    }

    // Older USD: outputs:surface is a relationship
    UsdRelationship surfaceRelationship =
        materialPrim.GetRelationship(TfToken("outputs:surface"));
    SdfPathVector targets;
    if (surfaceRelationship &&
        surfaceRelationship.GetForwardedTargets(&targets) &&
        !targets.empty()) {
        return materialPrim.GetStage()->GetPrimAtPath(targets[0].GetPrimPath());
    }

    for (const UsdRelationship& relationship : materialPrim.GetRelationships()) {
        if (!TfStringStartsWith(relationship.GetName().GetString(), "outputs:surface")) {
            continue;
        }

        targets.clear();
        if (relationship.GetForwardedTargets(&targets) && !targets.empty()) {
            return materialPrim.GetStage()->GetPrimAtPath(targets[0].GetPrimPath());
        }
    }

    // Fallback: scan direct children for the surface shader prim.
    // Used when outputs:surface connections are invisible to the USD 26 API
    // (happens with older USDZ files where API schemas weren't applied).
    for (const UsdPrim& child : materialPrim.GetChildren()) {
        TfToken shaderId;
        // Prefer the child that explicitly says it's a surface shader
        if (child.GetAttribute(TfToken("info:id")).Get(&shaderId) &&
            (shaderId == TfToken("UsdPreviewSurface") ||
             shaderId == TfToken("PxrSurface") ||
             TfStringEndsWith(shaderId.GetString(), "Surface"))) {
            return child;
        }
    }
    // Any shader child as last resort
    for (const UsdPrim& child : materialPrim.GetChildren()) {
        if (child.IsA<UsdShadeShader>()) {
            return child;
        }
    }

    return UsdPrim();
}

bool
_GetAuthoredInputFloat(const UsdPrim& prim, const TfToken& name, float* value)
{
    return prim.GetAttribute(TfToken("inputs:" + name.GetString())).Get(value);
}

bool
_GetAuthoredInputColor(const UsdPrim& prim, const TfToken& name, GfVec3f* value)
{
    return prim.GetAttribute(TfToken("inputs:" + name.GetString())).Get(value);
}

bool
_GetAuthoredConnectedTexturePath(const UsdPrim& shaderPrim, const TfToken& name, std::string* path)
{
    UsdPrim texturePrim =
        _GetConnectedSourcePrim(shaderPrim.GetAttribute(TfToken("inputs:" + name.GetString())));
    if (!texturePrim) {
        return false;
    }

    SdfAssetPath filePath;
    if (!texturePrim.GetAttribute(TfToken("inputs:file")).Get(&filePath)) {
        return false;
    }

    *path = !filePath.GetResolvedPath().empty()
        ? filePath.GetResolvedPath()
        : filePath.GetAssetPath();
    return !path->empty();
}

emscripten::val
_TryExtractTexture(
    const UsdShadeShader& shader,
    const UsdPrim& shaderPrim,
    const TfToken& inputName,
    const std::string& packageRootPath)
{
    std::string texturePath;
    if ((shader && _GetConnectedTexturePath(shader, inputName, &texturePath)) ||
        _GetAuthoredConnectedTexturePath(shaderPrim, inputName, &texturePath)) {
        emscripten::val texture = _ReadTextureAsset(texturePath, packageRootPath);
        if (!texture["data"].isUndefined()) {
            return texture;
        }
    }
    return emscripten::val::undefined();
}

// Scans material prim descendants for texture-producing shaders and maps each
// to a texture slot by file-name heuristic. This supports both UsdUVTexture
// and inline MaterialX ND_image_* nodes, giving the viewer a standard-material
// fallback when Three's MaterialX path cannot consume a given image format.
void
_ExtractTexturesFromShaderDescendants(
    const UsdPrim& root,
    const std::string& packageRootPath,
    emscripten::val& materialValue)
{
    for (const UsdPrim& child : UsdPrimRange(root)) {
        if (child == root) continue;

        TfToken shaderId;
        if (!child.GetAttribute(TfToken("info:id")).Get(&shaderId)) {
            continue;
        }
        const std::string shaderIdText = shaderId.GetString();
        if (shaderId != TfToken("UsdUVTexture") &&
            !TfStringStartsWith(shaderIdText, "ND_image_")) {
            continue;
        }

        SdfAssetPath filePath;
        if (!child.GetAttribute(TfToken("inputs:file")).Get(&filePath)) {
            continue;
        }

        const std::string rawPath = !filePath.GetResolvedPath().empty()
            ? filePath.GetResolvedPath()
            : filePath.GetAssetPath();
        if (rawPath.empty()) {
            continue;
        }

        emscripten::val texture = _ReadTextureAsset(rawPath, packageRootPath);
        if (texture["data"].isUndefined()) {
            continue;
        }

        const std::string lower = TfStringToLower(rawPath);

        // Color/diffuse detection: match "color", "diffuse", "albedo", "basecolor"
        // or presence of a valid outputs:rgb (color output) attribute
        const bool hasRgbOutput =
            (child.GetAttribute(TfToken("outputs:rgb")) &&
             child.GetAttribute(TfToken("outputs:rgb")).IsAuthored()) ||
            (child.GetAttribute(TfToken("outputs:out")) &&
             child.GetAttribute(TfToken("outputs:out")).GetTypeName() == SdfValueTypeNames->Color3f);
        const bool nameIsColor =
            lower.find("color") != std::string::npos ||
            lower.find("diffuse") != std::string::npos ||
            lower.find("albedo") != std::string::npos ||
            lower.find("basecolor") != std::string::npos;

        if ((hasRgbOutput || nameIsColor) && materialValue["diffuseTexture"].isUndefined()) {
            materialValue.set("diffuseTexture", texture);
        } else if ((lower.find("clearcoat") != std::string::npos &&
                    lower.find("rough") != std::string::npos) &&
                   materialValue["clearcoatRoughnessTexture"].isUndefined()) {
            materialValue.set("clearcoatRoughnessTexture", texture);
        } else if (lower.find("clearcoat") != std::string::npos &&
                   materialValue["clearcoatTexture"].isUndefined()) {
            materialValue.set("clearcoatTexture", texture);
        } else if ((lower.find("rough") != std::string::npos) &&
                   materialValue["roughnessTexture"].isUndefined()) {
            materialValue.set("roughnessTexture", texture);
        } else if ((lower.find("metal") != std::string::npos) &&
                   materialValue["metallicTexture"].isUndefined()) {
            materialValue.set("metallicTexture", texture);
        } else if ((lower.find("normal") != std::string::npos ||
                    lower.find("norm") != std::string::npos ||
                    lower.find("nrm") != std::string::npos) &&
                   materialValue["normalTexture"].isUndefined()) {
            materialValue.set("normalTexture", texture);
        } else if ((lower.find("occlusion") != std::string::npos ||
                    lower.find("_ao") != std::string::npos) &&
                   materialValue["occlusionTexture"].isUndefined()) {
            materialValue.set("occlusionTexture", texture);
        } else if ((lower.find("emissive") != std::string::npos ||
                    lower.find("emission") != std::string::npos) &&
                   materialValue["emissiveTexture"].isUndefined()) {
            materialValue.set("emissiveTexture", texture);
        } else if ((lower.find("opacity") != std::string::npos ||
                    lower.find("alpha") != std::string::npos) &&
                   materialValue["opacityTexture"].isUndefined()) {
            materialValue.set("opacityTexture", texture);
        }
    }
}

emscripten::val
_ExtractMaterial(
    const UsdPrim& prim,
    const std::string& packageRootPath,
    UsdShadeMaterialBindingAPI::BindingsCache* bindingsCache,
    UsdShadeMaterialBindingAPI::CollectionQueryCache* collectionQueryCache,
    const emscripten::val& fallbackColor)
{
    emscripten::val materialValue = emscripten::val::object();
    materialValue.set("diffuseColor", fallbackColor);
    materialValue.set("roughness", 0.55f);
    materialValue.set("metallic", 0.05f);
    materialValue.set("opacity", 1.0f);

    UsdShadeMaterial material = _FindBoundMaterialByAuthoredRelationships(prim);
    if (!material) {
        material = UsdShadeMaterialBindingAPI(prim).ComputeBoundMaterial(
            bindingsCache,
            collectionQueryCache);
    }

    UsdPrim materialPrim = material ? material.GetPrim() : UsdPrim();
    if (!materialPrim) {
        materialPrim = _FindBoundMaterialPrimByAuthoredRelationships(prim);
    }
    if (!materialPrim) {
        return materialValue;
    }

    materialValue.set("path", materialPrim.GetPath().GetString());

    TfToken sourceName;
    UsdShadeAttributeType sourceType;
    UsdShadeShader shader;
    if (material) {
        shader = material.ComputeSurfaceSource(
            {UsdShadeTokens->universalRenderContext},
            &sourceName,
            &sourceType);
    }

    UsdPrim shaderPrim = shader ? shader.GetPrim() : _FindSurfaceShaderPrim(materialPrim);
    if (!shaderPrim) {
        return materialValue;
    }

    TfToken shaderId;
    if (shader && shader.GetShaderId(&shaderId)) {
        materialValue.set("shaderId", shaderId.GetString());
    } else if (shaderPrim.GetAttribute(TfToken("info:id")).Get(&shaderId)) {
        materialValue.set("shaderId", shaderId.GetString());
    }

    if (materialPrim) {
        _ExtractTexturesFromShaderDescendants(materialPrim, packageRootPath, materialValue);
    }

    if (shader) {
        emscripten::val materialX = _ReadMaterialXAsset(shader, packageRootPath);
        if (!materialX.isUndefined()) {
            _AttachMaterialTextureResources(materialValue, materialX);
            materialValue.set("materialX", materialX);
            return materialValue;
        }
    }

    emscripten::val materialX = _ReadMaterialXAssetFromMaterialPrim(materialPrim, packageRootPath);
    if (!materialX.isUndefined()) {
        _AttachMaterialTextureResources(materialValue, materialX);
        materialValue.set("materialX", materialX);
        return materialValue;
    }

    emscripten::val inlineMaterialX = _BuildInlineMaterialXAsset(materialPrim);
    if (!inlineMaterialX.isUndefined()) {
        _AttachMaterialTextureResources(materialValue, inlineMaterialX);
        materialValue.set("materialX", inlineMaterialX);
        return materialValue;
    }

    // Scalar properties
    GfVec3f diffuseColor;
    if ((shader && _GetInputColor(shader, TfToken("diffuseColor"), &diffuseColor)) ||
        _GetAuthoredInputColor(shaderPrim, TfToken("diffuseColor"), &diffuseColor)) {
        materialValue.set("diffuseColor", _Vec3Array(diffuseColor));
    }

    GfVec3f emissiveColor;
    if ((shader && _GetInputColor(shader, TfToken("emissiveColor"), &emissiveColor)) ||
        _GetAuthoredInputColor(shaderPrim, TfToken("emissiveColor"), &emissiveColor)) {
        materialValue.set("emissiveColor", _Vec3Array(emissiveColor));
    }

    float scalar = 0.0f;
    if ((shader && _GetInputFloat(shader, TfToken("roughness"), &scalar)) ||
        _GetAuthoredInputFloat(shaderPrim, TfToken("roughness"), &scalar)) {
        materialValue.set("roughness", scalar);
    }
    if ((shader && _GetInputFloat(shader, TfToken("metallic"), &scalar)) ||
        _GetAuthoredInputFloat(shaderPrim, TfToken("metallic"), &scalar)) {
        materialValue.set("metallic", scalar);
    }
    if ((shader && _GetInputFloat(shader, TfToken("opacity"), &scalar)) ||
        _GetAuthoredInputFloat(shaderPrim, TfToken("opacity"), &scalar)) {
        materialValue.set("opacity", scalar);
    }
    if ((shader && _GetInputFloat(shader, TfToken("clearcoat"), &scalar)) ||
        _GetAuthoredInputFloat(shaderPrim, TfToken("clearcoat"), &scalar)) {
        materialValue.set("clearcoat", scalar);
    }
    if ((shader && _GetInputFloat(shader, TfToken("clearcoatRoughness"), &scalar)) ||
        _GetAuthoredInputFloat(shaderPrim, TfToken("clearcoatRoughness"), &scalar)) {
        materialValue.set("clearcoatRoughness", scalar);
    }
    if ((shader && _GetInputFloat(shader, TfToken("ior"), &scalar)) ||
        _GetAuthoredInputFloat(shaderPrim, TfToken("ior"), &scalar)) {
        materialValue.set("ior", scalar);
    }

    // Texture channels
    static const struct { const char* inputName; const char* resultKey; } kTextureSlots[] = {
        { "diffuseColor",       "diffuseTexture"            },
        { "roughness",          "roughnessTexture"          },
        { "metallic",           "metallicTexture"           },
        { "normal",             "normalTexture"             },
        { "occlusion",          "occlusionTexture"          },
        { "emissiveColor",      "emissiveTexture"           },
        { "clearcoat",          "clearcoatTexture"          },
        { "clearcoatRoughness", "clearcoatRoughnessTexture" },
        { "opacity",            "opacityTexture"            },
    };

    bool foundTexture = false;
    for (const auto& slot : kTextureSlots) {
        emscripten::val texture = _TryExtractTexture(
            shader, shaderPrim, TfToken(slot.inputName), packageRootPath);
        if (!texture.isUndefined()) {
            materialValue.set(slot.resultKey, texture);
            foundTexture = true;
        }
    }

    if (!foundTexture && materialPrim && materialValue["diffuseTexture"].isUndefined()) {
        _ExtractTexturesFromShaderDescendants(materialPrim, packageRootPath, materialValue);
    }

    return materialValue;
}

std::vector<MaterialSubsetGroup>
_ExtractMaterialSubsetGroupsFromFaceRuns(
    const UsdGeomMesh& mesh,
    const std::vector<int>& faceIndexStarts,
    const std::vector<int>& faceIndexCounts)
{
    std::vector<MaterialSubsetGroup> groups;
    for (const UsdPrim& child : mesh.GetPrim().GetChildren()) {
        if (!child.IsA<UsdGeomSubset>()) {
            continue;
        }

        TfToken elementType;
        child.GetAttribute(TfToken("elementType")).Get(&elementType);
        if (elementType != TfToken("face")) {
            continue;
        }

        TfToken familyName;
        child.GetAttribute(TfToken("familyName")).Get(&familyName);
        if (!familyName.IsEmpty() && familyName != TfToken("materialBind")) {
            continue;
        }

        VtArray<int> faceIndices;
        if (!child.GetAttribute(TfToken("indices")).Get(&faceIndices) ||
            faceIndices.empty()) {
            continue;
        }

        std::vector<int> sortedFaceIndices(faceIndices.begin(), faceIndices.end());
        std::sort(sortedFaceIndices.begin(), sortedFaceIndices.end());

        int runStart = -1;
        int runEnd = -1;
        for (const int faceIndex : sortedFaceIndices) {
            if (faceIndex < 0 ||
                static_cast<size_t>(faceIndex) >= faceIndexStarts.size()) {
                continue;
            }
            const int start = faceIndexStarts[faceIndex];
            const int count = faceIndexCounts[faceIndex];
            if (count <= 0) {
                continue;
            }

            if (runStart < 0) {
                runStart = start;
                runEnd = start + count;
                continue;
            }
            if (start == runEnd) {
                runEnd += count;
                continue;
            }

            groups.push_back({child, runStart, runEnd - runStart});
            runStart = start;
            runEnd = start + count;
        }

        if (runStart >= 0 && runEnd > runStart) {
            groups.push_back({child, runStart, runEnd - runStart});
        }
    }

    std::sort(
        groups.begin(),
        groups.end(),
        [](const MaterialSubsetGroup& a, const MaterialSubsetGroup& b) {
            return a.start < b.start;
        });
    return groups;
}

std::vector<MaterialSubsetGroup>
_ExtractMaterialSubsetGroups(const UsdGeomMesh& mesh, const MeshPayload& payload)
{
    return _ExtractMaterialSubsetGroupsFromFaceRuns(
        mesh,
        payload.faceIndexStarts,
        payload.faceIndexCounts);
}

void
_MaybeSetRenderableMaterialSubsets(
    emscripten::val* renderable,
    const UsdGeomMesh& mesh,
    const MeshPayload& payload,
    const std::string& packageRootPath,
    UsdShadeMaterialBindingAPI::BindingsCache* bindingsCache,
    UsdShadeMaterialBindingAPI::CollectionQueryCache* collectionQueryCache)
{
    if (!renderable || !bindingsCache || !collectionQueryCache) {
        return;
    }

    const std::vector<MaterialSubsetGroup> materialGroups =
        _ExtractMaterialSubsetGroups(mesh, payload);
    if (materialGroups.empty()) {
        return;
    }

    emscripten::val materialSubsets = emscripten::val::array();
    for (size_t subsetIndex = 0; subsetIndex < materialGroups.size(); ++subsetIndex) {
        const MaterialSubsetGroup& group = materialGroups[subsetIndex];
        emscripten::val subset = emscripten::val::object();
        subset.set("path", group.prim.GetPath().GetString());
        subset.set("name", group.prim.GetName().GetString());
        subset.set("start", group.start);
        subset.set("count", group.count);
        subset.set(
            "material",
            _ExtractMaterial(
                group.prim,
                packageRootPath,
                bindingsCache,
                collectionQueryCache,
                (*renderable)["color"]));
        materialSubsets.set(subsetIndex, subset);
    }
    renderable->set("materialSubsets", materialSubsets);
}

} // namespace usdwebview
