#!/usr/bin/env bash
#
# This script is run on the indexer by the `update.sh` script created by the
# provisioning process.  Its purpose is to:
# 1. Download/update dependencies that change frequently and need to be
#    up-to-date for indexing/analysis reasons (ex: spidermonkey for JS, rust).
# 2. Perform the build steps for mozsearch.
#
# When developing, this is also a good place to:
# - Install any additional dependencies you might need.
# - Perform any new build steps your changes need.
#
# However, when it comes time to land, it's preferable to make sure that
# dependencies that don't change should just be installed once at provisioning
# time.
#

set -x # Show commands
set -eu # Errors/undefined vars are fatal
set -o pipefail # Check all commands in a pipeline

# Update Rust (make sure we have the latest version).
# We need rust nightly to use the save-analysis, and firefox requires recent
# versions of Rust.
#
# Before we do the update, we remove some components that we don't need and
# that are sometimes missing. If they are missing, `rustup update` will try
# to use a previous nightly instead that does have the components, which means
# we end up with a slightly older rustc. Using rustc from a few days ago is
# usually fine, but in cases where we hit ICEs that have been fixed upstream,
# we want the very latest rustc to get the fix. Removing these components also
# reduces download time during `rustup update`.
#
# Note that these commands are not idempotent, so we need to `|| true` for cases
# where they've already been removed by a prior invocation of this script.
# (Originally this script would only ever be run on the indexers and web-servers
# at most once because the script would not be run during provisioning and each
# VM's root partition would be discarded after running.  Now we run this script
# as part of provisioning for side-effects.)
rustup component remove clippy || true
rustup component remove rustfmt || true
rustup component remove rust-docs || true
rustup component add rust-analyzer || true
rustup update

# Install SpiderMonkey.
rm -rf target.jsshell.zip js
wget -nv https://firefox-ci-tc.services.mozilla.com/api/index/v1/task/gecko.v2.mozilla-central.latest.firefox.linux64-opt/artifacts/public/build/target.jsshell.zip
mkdir js
pushd js
unzip ../target.jsshell.zip
sudo install js /usr/local/bin
sudo install *.so /usr/local/lib
sudo ldconfig
popd

pushd mozsearch/clang-plugin
make
popd

pushd mozsearch/tools
CARGO_INCREMENTAL=false cargo install --path . --verbose
rm -rf target
popd

pushd mozsearch/scripts/web-analyze/wasm-css-analyzer
./build.sh
popd

PYMODULES=$HOME/pymodules

# Delete the temp dir if IDL parsers are older than a day (in minutes to avoid
# quantization weirdness).  We'll also try and delete the dir if the file just
# doesn't exist, which also means if the directory doesn't exist.  (We could
# have instead done `-mmin +1440` for affirmative confirmation it's old, but
# since our next check is just for the existence of the directory, this is least
# likely to result in weirdness.)
if [ ! "$(find $PYMODULES/xpidl.py -mmin -1440)" ]; then
    rm -rf $PYMODULES
fi

# download/copy as needed
if [ ! -d "${PYMODULES}" ]; then
    mkdir "${PYMODULES}"
    pushd "${PYMODULES}"
    wget "https://github.com/mozilla-firefox/firefox/raw/refs/heads/main/xpcom/idl-parser/xpidl/xpidl.py"
    wget "https://github.com/mozilla-firefox/firefox/raw/refs/heads/main/dom/bindings/parser/WebIDL.py"
    mkdir ply
    pushd ply
    for PLYFILE in __init__.py lex.py yacc.py; do
        wget "https://github.com/mozilla-firefox/firefox/raw/refs/heads/main/third_party/python/ply/ply/${PLYFILE}"
    done
    popd
    popd
fi

# TODO: remove after next provisioning
if [ -d "$HOME/livegrep-grpc3/src" ]; then
  rm -rf "$HOME/livegrep-grpc3/src"

  LIVEGREP_VENV=$HOME/livegrep-venv
  PATH=$LIVEGREP_VENV/bin:$PATH

  git clone -b mozsearch-version7 https://github.com/mozsearch/livegrep --depth=1

  rm -rf livegrep-grpc3
  mkdir livegrep-grpc3
  pushd livegrep
  sed 's|import "src/proto/config.proto";|import "livegrep/config.proto";|' -i src/proto/livegrep.proto
  mkdir build
  python3 -m grpc_tools.protoc --python_out=build --grpc_python_out=build -I livegrep=src/proto "src/proto/config.proto" "src/proto/livegrep.proto"
  popd
  mv livegrep/build/livegrep livegrep-grpc3/livegrep
  rm -rf livegrep
fi
