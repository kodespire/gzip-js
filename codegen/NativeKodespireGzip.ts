// Declares the native module for React Native's codegen, which registers it with
// the app (see codegenConfig in package.json). Nothing imports this file: the module
// is written by hand in cpp/KodespireGzipModule.cpp, and src/jsi-backend.ts is its
// JavaScript side. Byte arrays are typed as Object because codegen has no Uint8Array.
import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  version(): string;
  compressSync(
    data: Object,
    format: number,
    level: number,
    windowBits: number,
    memLevel: number,
    strategy: number,
    dictionary: Object | null,
  ): Object;
  compress(
    data: Object,
    format: number,
    level: number,
    windowBits: number,
    memLevel: number,
    strategy: number,
    dictionary: Object | null,
  ): Promise<Object>;
  decompressSync(data: Object, format: number, dictionary: Object | null, maxOutputSize: number): Object;
  decompress(data: Object, format: number, dictionary: Object | null, maxOutputSize: number): Promise<Object>;
  createCStream(
    format: number,
    level: number,
    windowBits: number,
    memLevel: number,
    strategy: number,
    dictionary: Object | null,
  ): Object;
  createDStream(format: number, dictionary: Object | null, maxOutputSize: number): Object;
}

export default TurboModuleRegistry.get<Spec>('KodespireGzip');
