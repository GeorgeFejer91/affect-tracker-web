# Generated study-core browser package

These files are generated from `crates/study-core` and provide the same study
authority used by native adapters to GitHub Pages and WebXR.

Regenerate them from the repository root with:

```powershell
pnpm build:study-core-wasm
```

The packaging script pins `wasm-bindgen 0.2.127`. Do not hand-edit the generated
JavaScript or WebAssembly files.

Release builds regenerate this package on the pinned Linux CI toolchain, compare
the generated JavaScript and TypeScript ABI with the checked-in package, and run
the shared behavioral fixtures against the regenerated WebAssembly. The validated
CI package is the one deployed to GitHub Pages. WebAssembly code generation is not
assumed to be byte-identical across Windows and Linux hosts.
