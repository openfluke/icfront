Isocard depends on loading `jolt-physics` (WebAssembly) at runtime.  
You need a bundler that:

- Excludes `jolt-physics` from dependency pre-bundling
- Serves `.wasm` files as static assets

### Recommended

- [Vite](https://vitejs.dev/) (React, Vue, Svelte, Solid, Astro, etc.)
- Ionic React (uses Vite under the hood)
- Next.js 14+ (with Turbopack/Webpack configured for WASM)

### Not Supported

- Create React App (CRA) without ejecting
- React Native (use a WebView if you want mobile)
- Any bundler that cannot handle `.wasm` as static files


ionic start simple-iso blank --type=react --vite --capacitor


bun add jolt-physics three

# If developing isocard locally
bun add isocard@link:isocard


bun run dev