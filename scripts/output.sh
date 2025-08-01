#!/usr/bin/env bash

set -x # Show commands
set -eu # Errors/undefined vars are fatal
set -o pipefail # Check all commands in a pipeline

if [ $# -ne 5 ]
then
    echo "Usage: output.sh config_repo config-file.json tree_name url-map.json"
    exit 1
fi

CONFIG_REPO=$(realpath $1)
CONFIG_FILE=$(realpath $2)
TREE_NAME=$3
URL_MAP_PATH=$4
DOC_TREES_PATH=$5

# let's put the "parallel" output in a new `diags` directory, as we're still
# seeing really poor output-file performance in bug 1567724.
DIAGS_DIR=$INDEX_ROOT/diags/output
mkdir -p $DIAGS_DIR
# clean up the directory since in the VM this can persist.
rm -f $DIAGS_DIR/*

JOBLOG_PATH=${DIAGS_DIR}/output.joblog
# let's put all the temp files in our diagnostic dir too.
TMPDIR_PATH=${DIAGS_DIR}

# parallel args:
# --jobs 8: Limits us to 8 jobs to avoid creating an OOM nightmare; this is
#   consistent with our vagrant-on-linux setting.  The immediate motivation is
#   that under docker all of the system's cores will be exposed, which is
#   good for non-memory-intensive things.  But for mozilla-central, each
#   output-file instance ends up using ~2GiB of RAM individually and so a memory
#   budget of ~16GiB is reasonable.  Otherwise on my 28-core machines the 64GiB
#   of RAM gets eaten up and every other process terminated.
#   TODO: Overhaul output-file to have better memory usage characteristics by
#   using forking or just being parallel itself or something.
# --pipepart, -a: Pass the filenames to each job on the job's stdin by chopping
#   up the file passed via `-a`.  Compare with `--pipe` which instead divvies
#   inside the parallel perl process and can in theory be a bottleneck.
# --files: Place .par files in the ${TMPDIR_PATH} above which is now not
#   actually a temporary directory but instead a path we save so that we can see
#   what the output of the run was.
# --joblog: Emit a joblog that can be used to `--resume` the previous job and
#   also provides us with general performance runtime info
# --tmpdir: We specify the location of the .par files via this.
# --block: by passing `-1` we indicate each job should get 1 block of data, with
#   the size of the block basically being (1/nproc * file size).  A value of
#   `-2` would give each job a block half the size and result in twice as many
#   jobs (and therefore twice as much overhead).  The general trade-off reason
#   you might do this is that parallel can detect when a process terminates but
#   not when it's idle.  So to load balance, you potentially would want more
#   jobs, but we're looking at a startup cost of ~15 seconds per process, and
#   we can process about 2000 lines of source per 0.1 second with all 4 cores
#   active, so that suggests we give up about 300kloc's worth of rendering for
#   additional job, which potentially covers a lot of slop.  Also, there's a
#   chance that as some output-file jobs complete earlier, the other jobs may
#   then accelerate as there is reduced contention for (SSD) I/O and spare RAM
#   may increase to allow for writes to be buffered without needing to flush,
#   etc.
# --env RUST_BACKTRACE: propagate the RUST_BACKTRACE environment variable.
# "2>&1": If we don't do this, `--files` seems to just eat the stderr output
#   which is obviously suboptimal.
parallel --jobs 8 --pipepart -a $INDEX_ROOT/all-files --files --joblog $JOBLOG_PATH --tmpdir $TMPDIR_PATH \
    --block -1 --halt 2 --env RUST_BACKTRACE \
    "output-file $CONFIG_FILE $TREE_NAME $URL_MAP_PATH $DOC_TREES_PATH - 2>&1"

TOOL_CMD="search-files --limit=0 --include-dirs --group-by=directory | batch-render dir"
SEARCHFOX_SERVER=${CONFIG_FILE} \
    SEARCHFOX_TREE=${TREE_NAME} \
    searchfox-tool "$TOOL_CMD"

TOOL_CMD="render search-template"
SEARCHFOX_SERVER=${CONFIG_FILE} \
    SEARCHFOX_TREE=${TREE_NAME} \
    searchfox-tool "$TOOL_CMD"

TOOL_CMD="render help"
SEARCHFOX_SERVER=${CONFIG_FILE} \
    SEARCHFOX_TREE=${TREE_NAME} \
    searchfox-tool "$TOOL_CMD"

TOOL_CMD="render settings"
SEARCHFOX_SERVER=${CONFIG_FILE} \
    SEARCHFOX_TREE=${TREE_NAME} \
    searchfox-tool "$TOOL_CMD"
