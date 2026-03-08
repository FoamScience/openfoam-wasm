# OpenFOAM WASM

Run OpenFOAM CFD simulations entirely in the browser via WebAssembly.

This project cross-compiles a minimal OpenFOAM stack (v2512) to WASM using Emscripten and provides a web frontend that runs meshing and solving without any server-side computation.

>[!IMPORTANT]
> This requires an OpenFOAM installation to build, but not to run in the browser.

## What it does

- Compiles OpenFOAM core libraries to WebAssembly (static archives)
- Builds **blockMesh** and **scalarTransportFoam** as WASM executables
- Provides an example browser UI that:
  - Loads OpenFOAM WASM modules in a Web Worker
  - Runs blockMesh + solver with streaming console output
  - Renders 2D field visualization (scalar/vector fields with jet colormap)
  - Auto-generates editable forms for all case dictionaries (controlDict, fvSchemes, etc.)
    - This is not reflection/introspection
    - Case as a template -> user can change entries -> but no additions/removal
  - Shows the objectRegistry contents at each time step via a built-in `registryDump` functionObject
  - Provides a filesystem explorer for all solver outputs

## Libraries built
- libPstream (dummy)
- libOSspecific
- libOpenFOAM
- libfileFormats
- libsurfMesh
- libmeshTools
- libfiniteVolume
- libblockMesh
- libextrudeModel
- libdynamicMesh

## Prerequisites

- **Docker** with the `emscripten/emsdk:3.1.56` image
- **Git** (to clone OpenFOAM source)
- A modern browser with WebAssembly support (Chrome, Firefox, Safari, Edge)

## Quick start

```bash
# Clone this repo
git clone <repo-url> openfoam-wasm
cd openfoam-wasm

# Build everything (clones OpenFOAM v2512, patches, compiles via Docker)
./build.sh

# Serve the web app
cd dist
uv run python3 -m http.server 8080
```

Open `http://localhost:8080/test.html` in your browser.

## Build options

```bash
# Use an existing OpenFOAM source tree (skip clone)
./build.sh --foam-dir /path/to/openfoam

# Interactive Emscripten shell (for debugging)
./build.sh shell

# Clean build artifacts (have to remove the patforms folder manually if --from-dir is used)
./build.sh clean

# Control parallelism
JOBS=8 ./build.sh
```

## How it works

1. **Build phase**: The build script runs inside a Docker container with Emscripten, compiles OpenFOAM libs to static `.a` archives, then links the solver executables as `.wasm` + `.js` modules.

2. **Runtime**: The browser loads the WASM modules into a Web Worker. Case files are written to Emscripten's in-memory filesystem (MEMFS). `blockMesh` generates the mesh, then `scalarTransportFoam` runs the simulation. Results are read back from MEMFS and rendered on a canvas.

3. **Key WASM adaptations**:
   - `POSIX.C` guards around `dlopen`, signals, sockets (not available in WASM)
   - Static linking with `--whole-archive` to preserve Runtime Selection Tables
   - `dummyPrintStack` replaces `execinfo.h`-based stack traces
   - `-fexceptions` and `-sDISABLE_EXCEPTION_CATCHING=0` for C++ exception support
   - `-sUSE_ZLIB=1` for compressed I/O support

## Included tutorial

**pitzDaily** (scalarTransportFoam) — 2D backward-facing step with passive scalar transport. Editable via the auto-generated case editor in the browser.

## Adding more solvers

1. Ensure all required libraries are in the build list in `build.sh`
2. Add a `build_app` line for the solver
3. Update `collect_dist` to copy the new WASM binary
4. Exclude `coded*`/`codeStream` features (requires `dlopen`)

> WASM binaries can get a bit large; we probably can optimize what to include in them,
> but they will get large anyway (no dlopen) so I din't care enough; They ship everything.

## Related projects

- [tree-sitter-foam](https://github.com/FoamScience/tree-sitter-foam) a tree-sitter grammar for OpenFOAM, WASM-buildable

## License

OpenFOAM is licensed under the GNU General Public License v3.0. See the [OpenFOAM license](https://www.openfoam.com/licence) for details.
