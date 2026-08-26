#include "webviewCommon.h"

namespace usdwebview {

emscripten::val
_ErrorResult(const std::string& path, const std::string& message)
{
    emscripten::val result = emscripten::val::object();
    result.set("rootFile", path);
    result.set("error", message);
    return result;
}

emscripten::val
_FloatArray(const std::vector<float>& values)
{
    emscripten::val array = emscripten::val::array();
    for (size_t i = 0; i < values.size(); ++i) {
        array.set(i, values[i]);
    }
    return array;
}

emscripten::val
_IntArray(const std::vector<int>& values)
{
    emscripten::val array = emscripten::val::array();
    for (size_t i = 0; i < values.size(); ++i) {
        array.set(i, values[i]);
    }
    return array;
}

emscripten::val
_MatrixArray(const GfMatrix4d& matrix)
{
    emscripten::val array = emscripten::val::array();
    size_t index = 0;
    for (size_t row = 0; row < 4; ++row) {
        for (size_t column = 0; column < 4; ++column) {
            array.set(index++, matrix[row][column]);
        }
    }
    return array;
}

emscripten::val
_MatrixArrayVector(const std::vector<GfMatrix4d>& matrices)
{
    emscripten::val array = emscripten::val::array();
    for (size_t index = 0; index < matrices.size(); ++index) {
        array.set(index, _MatrixArray(matrices[index]));
    }
    return array;
}

emscripten::val
_Float32Array(const std::vector<float>& values)
{
    if (values.empty()) {
        return emscripten::val::global("Float32Array").new_(0);
    }
    return emscripten::val::global("Float32Array")
        .new_(emscripten::typed_memory_view(values.size(), values.data()));
}

template <typename T>
bool
_FormatVtArrayPreview(
    const VtValue& value,
    std::string* result,
    size_t maxElements = 512)
{
    if (!value.IsHolding<VtArray<T>>()) {
        return false;
    }

    const VtArray<T>& array = value.UncheckedGet<VtArray<T>>();
    std::ostringstream oss;
    const size_t count = std::min(array.size(), maxElements);
    for (size_t i = 0; i < count; ++i) {
        if (i > 0) {
            oss << ", ";
        }
        oss << array[i];
    }
    if (array.size() > count) {
        if (count > 0) {
            oss << ", ";
        }
        oss << "... " << (array.size() - count) << " more";
    }
    *result = oss.str();
    return true;
}

bool
_FormatVtArrayPreview(const VtValue& value, std::string* result)
{
    return
        _FormatVtArrayPreview<int>(value, result) ||
        _FormatVtArrayPreview<unsigned int>(value, result) ||
        _FormatVtArrayPreview<int64_t>(value, result) ||
        _FormatVtArrayPreview<uint64_t>(value, result) ||
        _FormatVtArrayPreview<float>(value, result) ||
        _FormatVtArrayPreview<double>(value, result) ||
        _FormatVtArrayPreview<GfHalf>(value, result) ||
        _FormatVtArrayPreview<GfVec2f>(value, result) ||
        _FormatVtArrayPreview<GfVec3f>(value, result) ||
        _FormatVtArrayPreview<GfVec4f>(value, result) ||
        _FormatVtArrayPreview<GfVec2d>(value, result) ||
        _FormatVtArrayPreview<GfVec3d>(value, result) ||
        _FormatVtArrayPreview<GfVec4d>(value, result) ||
        _FormatVtArrayPreview<GfVec2i>(value, result) ||
        _FormatVtArrayPreview<GfVec3i>(value, result) ||
        _FormatVtArrayPreview<GfVec4i>(value, result) ||
        _FormatVtArrayPreview<TfToken>(value, result) ||
        _FormatVtArrayPreview<std::string>(value, result);
}

emscripten::val
_Vec3Array(const GfVec3f& value)
{
    emscripten::val array = emscripten::val::array();
    array.set(0, value[0]);
    array.set(1, value[1]);
    array.set(2, value[2]);
    return array;
}

emscripten::val
_BytesArray(const std::vector<unsigned char>& bytes)
{
    return emscripten::val::global("Uint8Array")
        .new_(emscripten::typed_memory_view(bytes.size(), bytes.data()));
}

} // namespace usdwebview
