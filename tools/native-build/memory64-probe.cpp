// Address-width and Embind probe. Touches one byte per 64 KiB, not every
// physical page: this tests >4 GiB addressing, not sustained RAM residency.
#include <emscripten/bind.h>
#include <emscripten/heap.h>
#include <cstdint>
#include <cstdlib>
#include <string>

static_assert(sizeof(void*) == 8, "Build this probe with -sMEMORY64=1");

emscripten::val ProbeMemory64()
{
    using emscripten::val;
    constexpr size_t boundary = size_t{4} * 1024 * 1024 * 1024;
    constexpr size_t count = boundary + 65536;
    auto result = val::object();
    auto* allocation = static_cast<uint8_t*>(std::malloc(count));
    if (!allocation) {
        result.set("error", std::string("malloc failed"));
        return result;
    }
    volatile uint8_t* data = allocation;
    for (size_t i = 0; i < count; i += 65536) {
        data[i] = static_cast<uint8_t>((i / 65536) % 251);
    }
    bool sparseReadsMatch = true;
    for (size_t i = 0; i < count; i += 65536) {
        sparseReadsMatch &= data[i] == static_cast<uint8_t>((i / 65536) % 251);
    }
    // Distinct sentinels detect aliasing caused by 32-bit truncation.
    data[0] = 11;
    data[boundary - 1] = 22;
    data[boundary] = 33;
    data[count - 1] = 44;
    result.set("sentinelsMatch",
        data[0] == 11 && data[boundary - 1] == 22 &&
        data[boundary] == 33 && data[count - 1] == 44);
    for (size_t i = 0; i < 8; ++i) data[boundary + i] = uint8_t(100 + i);
    const auto copy = val::global("Uint8Array").new_(
        val(emscripten::typed_memory_view(size_t{8}, allocation + boundary)));
    const size_t heapBefore = emscripten_get_heap_size();
    const bool grew = emscripten_resize_heap(heapBefore + 64 * 1024 * 1024);
    result.set("pointerBytes", unsigned(sizeof(void*)));
    result.set("highAddress", std::to_string(reinterpret_cast<uintptr_t>(allocation + boundary)));
    result.set("heapBefore", double(heapBefore));
    result.set("heapAfter", double(emscripten_get_heap_size()));
    result.set("grew", grew);
    result.set("sparseReadsMatch", sparseReadsMatch);
    result.set("copy", copy);
    std::free(allocation);
    return result;
}

EMSCRIPTEN_BINDINGS(memory64_probe) {
    emscripten::function("probeMemory64", &ProbeMemory64);
}
