#!/usr/bin/env bash
# Builds websupport_with_flow-1.0.0.zip: Web Support's own files, copied
# through unmodified, plus Message Flow's compiled classes merged into one
# shared jar, plus the webadmin/ folder that turns Message Flow into a nav
# tab inside the Web Support shell instead of its own separately-deployed
# page.
#
# Usage:
#   SERVER_LIB=/path/to/server-lib WEBSUPPORT_SOURCE=/path/to/websupport-1_0_3.zip ./build.sh
#
# WEBSUPPORT_SOURCE can be the zip itself or an already-extracted folder
# containing oie-webadmin.war and websupport-shared.jar.

set -euo pipefail
cd "$(dirname "$0")"

if [ -z "${SERVER_LIB:-}" ] || [ -z "${WEBSUPPORT_SOURCE:-}" ]; then
  echo "Usage: SERVER_LIB=/path/to/server-lib WEBSUPPORT_SOURCE=/path/to/websupport-1_0_3.zip ./build.sh" >&2
  exit 1
fi
if [ ! -d "$SERVER_LIB" ]; then
  echo "SERVER_LIB '$SERVER_LIB' is not a directory." >&2
  exit 1
fi
if [ ! -e "$WEBSUPPORT_SOURCE" ]; then
  echo "WEBSUPPORT_SOURCE '$WEBSUPPORT_SOURCE' not found." >&2
  exit 1
fi

WORK=build
rm -rf "$WORK"
mkdir -p "$WORK/classes"

# --- Locate websupport's own files (unzip if given a .zip) -----------------

WS_ROOT="$WEBSUPPORT_SOURCE"
if [ -f "$WEBSUPPORT_SOURCE" ]; then
  echo "Extracting $WEBSUPPORT_SOURCE ..."
  WS_ROOT="$WORK/websupport-extracted"
  mkdir -p "$WS_ROOT"
  unzip -o -q "$WEBSUPPORT_SOURCE" -d "$WS_ROOT"
fi

WS_WAR="$(find "$WS_ROOT" -name 'oie-webadmin.war' | head -1)"
WS_JAR="$(find "$WS_ROOT" -name 'websupport-shared.jar' | head -1)"
if [ -z "$WS_WAR" ] || [ -z "$WS_JAR" ]; then
  echo "Could not find oie-webadmin.war and websupport-shared.jar under $WS_ROOT -- is this really the websupport zip/folder?" >&2
  exit 1
fi
echo "Found oie-webadmin.war: $WS_WAR"
echo "Found websupport-shared.jar: $WS_JAR"

# --- Compile Message Flow's Java sources ------------------------------------

CP="$(find "$SERVER_LIB" -name '*.jar' | tr '\n' ':')"
if [ -z "$CP" ]; then
  echo "No jars found under $SERVER_LIB — check the path." >&2
  exit 1
fi

echo "Compiling against $(echo "$CP" | tr ':' '\n' | grep -c .) jars from $SERVER_LIB ..."
javac -encoding UTF-8 -cp "$CP" -d "$WORK/classes" $(find src -name '*.java')

# --- Merge websupport-shared.jar's classes with our own compiled classes ---

echo "Merging classes into websupport_with_flow-shared.jar ..."
COMBINED="$WORK/classes-combined"
mkdir -p "$COMBINED"
unzip -o -q "$WS_JAR" -d "$COMBINED"
cp -r "$WORK/classes/." "$COMBINED/"

(cd "$COMBINED" && jar --create --file "$(pwd)/../websupport_with_flow-shared.jar" .)

# --- Stage everything -------------------------------------------------------

echo "Staging files ..."
STAGE="$WORK/stage/websupport_with_flow"
mkdir -p "$STAGE/webadmin/web"
cp plugin.xml "$STAGE/plugin.xml"
cp "$WORK/websupport_with_flow-shared.jar" "$STAGE/websupport_with_flow-shared.jar"
cp "$WS_WAR" "$STAGE/oie-webadmin.war"
cp webadmin/plugin.json "$STAGE/webadmin/plugin.json"
cp webadmin/web/plugin.js "$STAGE/webadmin/web/plugin.js"

echo "Assembling websupport_with_flow-1.0.0.zip ..."
OUT="$(pwd)/websupport_with_flow-1.0.0.zip"
rm -f "$OUT"
(cd "$WORK/stage" && zip -r -X "$OUT" websupport_with_flow > /dev/null)

echo
echo "Done: $OUT"
echo "Install it from the engine Administrator's Extensions page (Browse... / Install)."
echo "If Web Support (or the old standalone Message Flow) is already installed, remove it first --"
echo "this package replaces both. Restart the engine, then open the Web Support webadmin and look"
echo "for the new 'Message Flow' item under the Monitor section of the left rail."
