import { Mesh, Texture, type BufferGeometry, type Object3D, type BufferAttribute, type InterleavedBufferAttribute } from "three";

// Inventory only: never allocates copies of the large buffers being measured.
export function collectResourceMetrics(root: Object3D, extraTextures: Iterable<Texture> = []) {
  const buffers = new Set<ArrayBufferLike>();
  const textures = new Set<Texture>(extraTextures);
  const geometries = new Set<unknown>();
  let instances = 0;
  const addAttribute = (attribute?: BufferAttribute | InterleavedBufferAttribute | null) => {
    if (!attribute) return;
    const array = "data" in attribute ? attribute.data.array : attribute.array;
    buffers.add(array.buffer);
  };
  root.traverse(object => {
    if (!(object instanceof Mesh)) return;
    const geometry = object.geometry as BufferGeometry;
    geometries.add(geometry);
    Object.values(geometry.attributes).forEach(addAttribute);
    Object.values(geometry.morphAttributes).forEach(attributes => attributes?.forEach(addAttribute));
    addAttribute(geometry.index);
    const instanced = object as Mesh & { instanceMatrix?: BufferAttribute; instanceColor?: BufferAttribute; count?: number };
    addAttribute(instanced.instanceMatrix);
    addAttribute(instanced.instanceColor);
    if (instanced.instanceMatrix) instances += instanced.count ?? 0;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      // Shader graph-private resources cannot be enumerated reliably here.
      for (const value of Object.values(material)) if (value instanceof Texture) textures.add(value);
    }
  });
  let textureRgba8Bytes = 0;
  let sizedTextures = 0;
  for (const texture of textures) {
    const image = texture.image as { width?: number; height?: number; depth?: number } | undefined;
    if (image?.width && image?.height) {
      textureRgba8Bytes += image.width * image.height * (image.depth ?? 1) * 4;
      sizedTextures++;
    }
  }
  return {
    geometryBufferBytes: [...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0),
    geometries: geometries.size,
    instances,
    textureRgba8Bytes,
    sizedTextures,
    knownTextures: textures.size,
  };
}
