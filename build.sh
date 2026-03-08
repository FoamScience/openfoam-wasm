#!/bin/bash
# ===========================================================================
# OpenFOAM → WASM build script (standalone, Docker-based)
#
# This repo is independent of the OpenFOAM source tree. It:
#   1. Clones (or reuses) OpenFOAM v2512
#   2. Applies WASM patches
#   3. Installs wmake rules for Emscripten
#   4. Builds libraries + applications via Docker/Emscripten
#   5. Copies outputs to dist/ for the web app
#
# Usage:
#   ./build.sh                     # Full build (clone + patch + compile)
#   ./build.sh --foam-dir /path    # Use existing OpenFOAM source
#   ./build.sh shell               # Interactive Emscripten shell
#   ./build.sh clean               # Clean build artifacts
#   JOBS=8 ./build.sh              # Override parallelism
# ===========================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EMSDK_IMAGE="emscripten/emsdk:3.1.56"
CONTAINER_FOAM="/src/openfoam"
OPENFOAM_GIT="https://develop.openfoam.com/Development/openfoam.git"
OPENFOAM_TAG="OpenFOAM-v2512"

JOBS="${JOBS:-$(( $(nproc) / 2 ))}"
[ "$JOBS" -lt 1 ] && JOBS=1

# ── Parse arguments ──────────────────────────────────────────────────────────

FOAM_DIR=""
MODE="all"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --foam-dir) FOAM_DIR="$2"; shift 2 ;;
        clean|shell|all|lib-*) MODE="$1"; shift ;;
        *) echo "Unknown arg: $1"; exit 1 ;;
    esac
done

# ── Obtain OpenFOAM source ───────────────────────────────────────────────────

if [ -z "$FOAM_DIR" ]; then
    FOAM_DIR="${SCRIPT_DIR}/openfoam"
fi

if [ "$MODE" != "clean" ] && [ ! -f "$FOAM_DIR/META-INFO/build-info" ]; then
    echo "==> OpenFOAM source not found at ${FOAM_DIR}"
    echo "    Cloning ${OPENFOAM_TAG} (shallow)..."
    git clone --depth 1 --branch "${OPENFOAM_TAG}" "${OPENFOAM_GIT}" "${FOAM_DIR}"
fi

# ── Apply patches & install wmake rules ──────────────────────────────────────

apply_patches() {
    local foam="$1"

    # Source patches (POSIX.C, uint64, label, fvOptions, Make/options, etc.)
    if ! grep -q 'FOAM_WASM' "$foam/src/OSspecific/POSIX/POSIX.C" 2>/dev/null; then
        echo "==> Applying source patches..."
        cd "$foam"
        git apply "${SCRIPT_DIR}/patches/openfoam-wasm.patch" || {
            # If git apply fails (not a git repo or already partially applied), try patch
            patch -p1 < "${SCRIPT_DIR}/patches/openfoam-wasm.patch"
        }
        cd "$SCRIPT_DIR"
    else
        echo "==> Source patches already applied."
    fi

    # New source files (not in upstream, so not in the patch)
    local reg_dst="$foam/src/finiteVolume/functionObjects/registryDump"
    if [ ! -f "$reg_dst/registryDump.C" ]; then
        echo "==> Installing registryDump functionObject source..."
        mkdir -p "$reg_dst"
        cp "${SCRIPT_DIR}/src/finiteVolume/functionObjects/registryDump/registryDump.H" "$reg_dst/"
        cp "${SCRIPT_DIR}/src/finiteVolume/functionObjects/registryDump/registryDump.C" "$reg_dst/"
        # Add to finiteVolume Make/files
        local make_files="$foam/src/finiteVolume/Make/files"
        if ! grep -q 'registryDump' "$make_files" 2>/dev/null; then
            sed -i '/^functionObjects\/fvMeshFunctionObject\/fvMeshFunctionObject\.C/a functionObjects/registryDump/registryDump.C' "$make_files"
        fi
    fi

    # wmake rules for Emscripten
    local rules_dir="$foam/wmake/rules/linux64Emscripten"
    if [ ! -d "$rules_dir" ]; then
        echo "==> Installing wmake rules..."
        mkdir -p "$rules_dir"
        cp "${SCRIPT_DIR}"/wmake-rules/c "${SCRIPT_DIR}"/wmake-rules/c++ \
           "${SCRIPT_DIR}"/wmake-rules/c++Debug "${SCRIPT_DIR}"/wmake-rules/c++Opt \
           "${SCRIPT_DIR}"/wmake-rules/cDebug "${SCRIPT_DIR}"/wmake-rules/general \
           "$rules_dir/"
    fi

    # emar wrapper script
    if [ ! -f "$foam/wmake/scripts/emar-wrapper" ]; then
        cp "${SCRIPT_DIR}/wmake-rules/emar-wrapper" "$foam/wmake/scripts/"
        chmod +x "$foam/wmake/scripts/emar-wrapper"
    fi
}

# ── Docker build ─────────────────────────────────────────────────────────────

BUILD_SCRIPT='
set -e

apt-get update -qq && apt-get install -y -qq m4 flex libfl-dev >/dev/null 2>&1

if [ -f /usr/include/FlexLexer.h ]; then
    EMSDK_INC="${EMSDK}/upstream/emscripten/cache/sysroot/include"
    [ -d "$EMSDK_INC" ] && cp -n /usr/include/FlexLexer.h "$EMSDK_INC/" 2>/dev/null || true
fi

export WM_PROJECT_DIR='"${CONTAINER_FOAM}"'
export WM_DIR="${WM_PROJECT_DIR}/wmake"
export WM_PROJECT=OpenFOAM
export WM_ARCH=linux64
export WM_COMPILER=Emscripten
export WM_COMPILER_TYPE=system
export WM_PRECISION_OPTION=DP
export WM_LABEL_SIZE=32
export WM_LABEL_OPTION=Int32
export WM_COMPILE_OPTION=Opt
export WM_OPTIONS="${WM_ARCH}${WM_COMPILER}${WM_PRECISION_OPTION}${WM_LABEL_OPTION}${WM_COMPILE_OPTION}"
export WM_OSTYPE=POSIX
export FOAM_APPBIN="${WM_PROJECT_DIR}/platforms/${WM_OPTIONS}/bin"
export FOAM_LIBBIN="${WM_PROJECT_DIR}/platforms/${WM_OPTIONS}/lib"
export FOAM_SRC="${WM_PROJECT_DIR}/src"
export FOAM_APP="${WM_PROJECT_DIR}/applications"
export FOAM_ETC="${WM_PROJECT_DIR}/etc"
export FOAM_MPI=dummy
export WMAKE_BIN="${WM_PROJECT_DIR}/platforms/tools/linux64Gcc"
export PATH="${WM_DIR}:${WM_PROJECT_DIR}/bin:${PATH}"

mkdir -p "${FOAM_APPBIN}" "${FOAM_LIBBIN}/dummy"

WMAKE_TOOLS="${WM_PROJECT_DIR}/platforms/tools/linux64Gcc"
if [ ! -x "${WMAKE_TOOLS}/wmkdepend" ] || [ ! -x "${WMAKE_TOOLS}/lemon" ]; then
    echo "==> Building host tools..."
    mkdir -p "${WMAKE_TOOLS}"
    g++ -std=c++11 -O2 -o "${WMAKE_TOOLS}/wmkdepend" "${WM_DIR}/src/wmkdepend.cc"
    gcc -O2 -o "${WMAKE_TOOLS}/lemon" "${WM_DIR}/src/lemon.c"
fi

echo "==> OpenFOAM WASM Build"
echo "    WM_OPTIONS = ${WM_OPTIONS}"
echo "    Jobs = '"${JOBS}"'"
echo ""

build_lib() {
    local lib_dir="$1" lib_name="$2"
    echo "==> Building ${lib_name}..."
    cd "${FOAM_SRC}/${lib_dir}"
    wmake -j'"${JOBS}"' libso 2>&1 || { echo "FAILED: ${lib_name}"; return 1; }
    echo "    Done: ${lib_name}"
}

build_app() {
    local app_dir="$1" app_name="$2"
    echo "==> Building ${app_name}..."
    cd "${FOAM_APP}/${app_dir}"
    wmake -j'"${JOBS}"' 2>&1 || { echo "FAILED: ${app_name}"; return 1; }
    echo "    Done: ${app_name}"
}

build_lib "Pstream/dummy" "libPstream (dummy)"
build_lib "OSspecific/POSIX" "libOSspecific"
build_lib "OpenFOAM" "libOpenFOAM"
build_lib "fileFormats" "libfileFormats"
build_lib "surfMesh" "libsurfMesh"
build_lib "meshTools" "libmeshTools"
build_lib "finiteVolume" "libfiniteVolume"
build_lib "mesh/blockMesh" "libblockMesh"
build_lib "mesh/extrudeModel" "libextrudeModel"
build_lib "dynamicMesh" "libdynamicMesh"

echo ""
echo "==> Building applications..."
build_app "solvers/basic/scalarTransportFoam" "scalarTransportFoam"
build_app "utilities/mesh/generation/blockMesh" "blockMesh"

echo ""
echo "==> Build complete!"
ls -lh "${FOAM_APPBIN}/" 2>/dev/null || true
'

docker_run() {
    docker run --rm \
        -v "${FOAM_DIR}:${CONTAINER_FOAM}:rw" \
        -w "${CONTAINER_FOAM}" \
        "${EMSDK_IMAGE}" \
        /bin/bash -c "$1"
}

# ── Collect outputs into dist/ ───────────────────────────────────────────────

collect_dist() {
    local foam="$1"
    local dist="${SCRIPT_DIR}/dist"
    local platform="linux64EmscriptenDPInt32Opt"
    local bin="${foam}/platforms/${platform}/bin"

    echo "==> Collecting build outputs to dist/..."
    mkdir -p "$dist"/{build,etc,tutorials/basic/scalarTransportFoam}

    # WASM binaries + JS glue
    for app in blockMesh scalarTransportFoam; do
        cp "$bin/$app"      "$dist/build/${app}.js"
        cp "$bin/${app}.wasm" "$dist/build/"
    done

    # Runtime etc files
    cp "$foam/etc/controlDict" "$dist/etc/"
    cp "$foam/etc/cellModels"  "$dist/etc/"

    # Tutorial case
    cp -r "$foam/tutorials/basic/scalarTransportFoam/pitzDaily" \
          "$dist/tutorials/basic/scalarTransportFoam/"

    # Web app
    cp -r "${SCRIPT_DIR}"/web/* "$dist/"

    echo "    dist/ ready — serve with: cd dist && python3 -m http.server 8080"
}

# ── Main ─────────────────────────────────────────────────────────────────────

case "$MODE" in
    clean)
        echo "==> Cleaning"
        rm -rf "${FOAM_DIR}/platforms/linux64EmscriptenDPInt32Opt"
        rm -rf "${SCRIPT_DIR}/dist"
        echo "    Done."
        ;;
    shell)
        [ "$MODE" != "clean" ] && apply_patches "$FOAM_DIR"
        docker run --rm -it \
            -v "${FOAM_DIR}:${CONTAINER_FOAM}:rw" \
            -w "${CONTAINER_FOAM}" \
            "${EMSDK_IMAGE}" /bin/bash
        ;;
    *)
        if ! docker image inspect "${EMSDK_IMAGE}" &>/dev/null; then
            echo "==> Pulling ${EMSDK_IMAGE}..."
            docker pull "${EMSDK_IMAGE}"
        fi
        apply_patches "$FOAM_DIR"
        docker_run "$BUILD_SCRIPT"
        collect_dist "$FOAM_DIR"
        ;;
esac
