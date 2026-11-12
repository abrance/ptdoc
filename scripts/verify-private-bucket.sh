#!/usr/bin/env bash
# FR-26 真机验收：私有空间（private bucket）下 /a/<token> 的图片 URL 重签是否真的可用。
#
# 链路：私有 bucket → 传 1 张探针图 → 配 url_ttl=60 → 归档一篇测试文档 → 等 TTL 过期
#      → GET /a/<token>，断言 HTML 里的图片 URL 被重新签名（e 在未来）且 HEAD 200。
#
# 用法：
#   QINIU_AK=... QINIU_SK=... QINIU_BUCKET=... QINIU_DOMAIN=https://cdn.example.com \
#   PTDOC_BASE_URL=http://127.0.0.1:5173 PTDOC_USER=admin PTDOC_PASS=... \
#     scripts/verify-private-bucket.sh [--allow-remote] [--keep]
#
# 只对 127.0.0.1/localhost 的实例默认放行：脚本会覆盖该实例的存储配置（private_bucket=true, url_ttl=60），
# 跑到生产实例上会把线上存储配置改掉，所以远端必须显式 --allow-remote。
#
# 退出码：0 通过；1 断言失败；2 用法/环境问题；3 缺凭证（未执行任何网络请求）。

set -uo pipefail

BASE_URL="${PTDOC_BASE_URL:-http://127.0.0.1:5173}"
BUCKET="${QINIU_BUCKET:-}"
DOMAIN="${QINIU_DOMAIN:-}"
ZONE="${QINIU_ZONE:-Zone_z2}"
AK="${QINIU_AK:-}"
SK="${QINIU_SK:-}"
TTL=60
ALLOW_REMOTE=0
KEEP=0
DOC_KEY="ptdoc-private-verify/verify-$(date +%s).md"

for arg in "$@"; do
  case "$arg" in
    --allow-remote) ALLOW_REMOTE=1 ;;
    --keep) KEEP=1 ;;
    -h | --help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "未知参数：$arg" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
ok() { printf '  \033[32mPASS\033[0m %s\n' "$*"; }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; }
die() { printf '\033[31m错误\033[0m %s\n' "$*" >&2; exit "${2:-1}"; }

# ── 0. 前置检查 ───────────────────────────────────────────
for bin in curl openssl; do
  command -v "$bin" >/dev/null 2>&1 || die "缺少依赖：$bin" 2
done

missing=()
[ -n "$AK" ] || missing+=("QINIU_AK")
[ -n "$SK" ] || missing+=("QINIU_SK")
[ -n "$BUCKET" ] || missing+=("QINIU_BUCKET")
[ -n "$DOMAIN" ] || missing+=("QINIU_DOMAIN（必须是该私有 bucket 已绑定的域名，带协议头）")
[ -n "${PTDOC_USER:-}" ] || missing+=("PTDOC_USER")
[ -n "${PTDOC_PASS:-}" ] || missing+=("PTDOC_PASS")
if [ "${#missing[@]}" -gt 0 ]; then
  say "缺少必要配置，未做任何网络请求："
  for m in "${missing[@]}"; do say "  - $m"; done
  say ""
  say "需要的东西：一个私有测试 bucket + 它绑定的域名 + 该账号的 AK/SK，"
  say "以及一个可丢弃的 ptdoc 实例（脚本会覆盖它的存储配置）。"
  exit 3
fi

case "$DOMAIN" in
  http://* | https://*) ;;
  *) die "QINIU_DOMAIN 必须带协议头，例如 https://cdn.example.com" 2 ;;
esac

HOSTNAME_ONLY="$(printf '%s' "$BASE_URL" | sed -E 's#^https?://##; s#[:/].*$##')"
case "$HOSTNAME_ONLY" in
  127.0.0.1 | localhost) ;;
  *)
    [ "$ALLOW_REMOTE" = 1 ] ||
      die "拒绝在非本机实例（$HOSTNAME_ONLY）上运行：本脚本会覆盖该实例的存储配置。确认要走远端请加 --allow-remote" 2
    ;;
esac

WORK="$(mktemp -d)"
JAR="$WORK/cookies.txt"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT
FAILED=0

# ── 七牛签名工具 ──────────────────────────────────────────
# -w0：不加会按 76 列折行，policy 编码后 >76 字符时 token 里会夹换行
# 保留 '=' 填充：与七牛 SDK（util.base64ToUrlSafe 只替换 +/）逐字节一致
b64url() { base64 -w0 | tr '+/' '-_'; }
hmac_sha1_b64url() { printf '%s' "$1" | openssl dgst -sha1 -hmac "$SK" -binary | b64url; }

# 私有下载 URL：<domain>/<key>?e=<deadline>&token=<ak>:<sign(上面整串)>
private_url() { # key ttl_seconds
  local key="$1" ttl="$2" e url sign
  e=$(( $(date +%s) + ttl ))
  url="${DOMAIN%/}/${key}?e=${e}"
  sign="$(hmac_sha1_b64url "$url")"
  # 格式与 src/server/qiniu-uploader.ts makePrivateUrl 一致：<url>?e=<deadline>&token=<ak>:<sign>
  printf '%s&token=%s:%s' "$url" "$AK" "$sign"
}

# 七牛管理 API 签名串恒为 "<path>\n<body>"（见 qiniu/util.js generateAccessToken：body 为空也保留换行）
mgmt_auth() { # path [body]
  local access="$1" body="${2:-}" sign
  access="${access}
${body}"
  sign="$(printf '%s' "$access" | openssl dgst -sha1 -hmac "$SK" -binary | b64url)"
  printf 'QBox %s:%s' "$AK" "$sign"
}

# ── 1. 上传探针图到私有 bucket ────────────────────────────
say "== 1/6 上传探针图到私有 bucket（$BUCKET）"
case "$ZONE" in
  Zone_z0) UP_HOST=upload.qiniup.com ;;
  Zone_z1) UP_HOST=upload-z1.qiniup.com ;;
  Zone_z2) UP_HOST=upload-z2.qiniup.com ;;
  Zone_na0) UP_HOST=upload-na0.qiniup.com ;;
  Zone_as0) UP_HOST=upload-as0.qiniup.com ;;
  *) die "未知 QINIU_ZONE：$ZONE" 2 ;;
esac

# 1x1 PNG（70 字节，固定图，不读外部文件）
printf 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP4z8DwHwAFAAH/VscvDQAAAABJRU5ErkJggg==' | base64 -d >"$WORK/probe.png"
IMG_KEY="ptdoc-verify/probe-$(date +%s).png"
DEADLINE=$(( $(date +%s) + 3600 ))
PUT_POLICY="{\"scope\":\"${BUCKET}:${IMG_KEY}\",\"deadline\":${DEADLINE},\"insertOnly\":1}"
# 七牛上传凭证格式：<AccessKey>:<sign(encodedPolicy)>:<encodedPolicy>
UP_POLICY_ENCODED="$(printf '%s' "$PUT_POLICY" | b64url)"
UP_TOKEN="${AK}:$(hmac_sha1_b64url "$UP_POLICY_ENCODED"):${UP_POLICY_ENCODED}"

UP_RES="$(curl -sS -m 30 -w '\n%{http_code}' -X POST "https://${UP_HOST}/" \
  -F "token=${UP_TOKEN}" -F "key=${IMG_KEY}" -F "file=@${WORK}/probe.png")" ||
  die "上传请求失败（网络/DNS）"
UP_CODE="${UP_RES##*$'\n'}"
UP_BODY="${UP_RES%$'\n'*}"
if [ "$UP_CODE" = "200" ]; then ok "上传成功 key=${IMG_KEY}"; else bad "上传失败 HTTP ${UP_CODE} ${UP_BODY}"; exit 1; fi

# ── 2. 私有空间本身的行为：未签名 401，签名 200 ────────────
say "== 2/6 私有空间基线：未签名应 401，签名后应 200"
PLAIN_URL="${DOMAIN%/}/${IMG_KEY}"
PLAIN_CODE="$(curl -sS -o /dev/null -m 15 -w '%{http_code}' -I "$PLAIN_URL")"
if [ "$PLAIN_CODE" = "401" ] || [ "$PLAIN_CODE" = "403" ]; then
  ok "未签名 HEAD → ${PLAIN_CODE}（bucket 确为私有）"
else
  bad "未签名 HEAD → ${PLAIN_CODE}，bucket 看起来不是私有空间，后面的重签验证没有意义"
  FAILED=1
fi

SIGNED_URL="$(private_url "$IMG_KEY" 300)"
SIGNED_CODE="$(curl -sS -o /dev/null -m 15 -w '%{http_code}' -I "$SIGNED_URL")"
if [ "$SIGNED_CODE" = "200" ]; then ok "本脚本签名 HEAD → 200（签名算法与 bucket 一致）"; else
  bad "本脚本签名 HEAD → ${SIGNED_CODE}（AK/SK、域名或算法不对）"
  FAILED=1
fi

if [ "$FAILED" != 0 ]; then
  say ""
  say "基线没过，后面的 /a/<token> 验证没有意义，先停。"
  exit 1
fi

# ── 3. 把 ptdoc 实例指向这个私有 bucket ───────────────────
say "== 3/6 配置 ptdoc 存储（private_bucket=true, url_ttl=${TTL}s）"
LOGIN_CODE="$(curl -sS -o "$WORK/login.json" -m 15 -w '%{http_code}' -c "$JAR" \
  -X POST "$BASE_URL/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"${PTDOC_USER}\",\"password\":\"${PTDOC_PASS}\"}")"
[ "$LOGIN_CODE" = "200" ] || die "登录 $BASE_URL 失败 HTTP ${LOGIN_CODE}：$(cat "$WORK/login.json")" 2

STORAGE_JSON="$(printf '{"access_key":"%s","secret_key":"%s","bucket":"%s","domain":"%s","zone":"%s","private_bucket":true,"url_ttl":%s}' \
  "$AK" "$SK" "$BUCKET" "$DOMAIN" "$ZONE" "$TTL")"
SAVE_CODE="$(curl -sS -o "$WORK/storage.json" -m 60 -w '%{http_code}' -b "$JAR" \
  -X PUT "$BASE_URL/api/storage" -H 'Content-Type: application/json' -d "$STORAGE_JSON")"
[ "$SAVE_CODE" = "200" ] || die "保存存储配置失败 HTTP ${SAVE_CODE}：$(cat "$WORK/storage.json")"
ok "存储配置已保存（连通性由服务端实测通过）"

# 设置页自检接口顺带验一次（FR-26 的按钮背后就是它）
SC_CODE="$(curl -sS -o "$WORK/selfcheck.json" -m 60 -w '%{http_code}' -b "$JAR" -X POST "$BASE_URL/api/storage/selfcheck")"
SC_OK="$(sed -nE 's/.*"ok":(true|false).*/\1/p' "$WORK/selfcheck.json")"
SC_STATUS="$(sed -nE 's/.*"status":([0-9]+).*/\1/p' "$WORK/selfcheck.json")"
if [ "$SC_CODE" = "200" ] && [ "$SC_OK" = "true" ]; then
  ok "POST /api/storage/selfcheck → HEAD ${SC_STATUS}"
else
  bad "自检接口异常 HTTP ${SC_CODE}：$(cat "$WORK/selfcheck.json")"
  FAILED=1
fi

# ── 4. 建文档 + 归档 ─────────────────────────────────────
say "== 4/6 归档一篇引用该图片的测试文档"
# 文档图单独签一个短 TTL：要能在后面的等待窗口内真的过期（用 300s 那个会等到天荒地老）
DOC_IMG_TTL=30
DOC_IMG_EXP=$(( $(date +%s) + DOC_IMG_TTL ))
DOC_SIGNED_URL="$(private_url "$IMG_KEY" "$DOC_IMG_TTL")"
DOC_BODY="$(printf '{"doc_key":"%s","title":"私有空间验收","content":"# 私有空间验收\\n\\n![probe](%s)\\n"}' \
  "$DOC_KEY" "$DOC_SIGNED_URL")"
DOC_CODE="$(curl -sS -o "$WORK/doc.json" -m 20 -w '%{http_code}' -b "$JAR" \
  -X POST "$BASE_URL/api/docs" -H 'Content-Type: application/json' -d "$DOC_BODY")"
[ "$DOC_CODE" = "200" ] || die "建文档失败 HTTP ${DOC_CODE}：$(cat "$WORK/doc.json")"
DOC_ID="$(sed -nE 's/.*"id":[[:space:]]*([0-9]+).*/\1/p' "$WORK/doc.json" | head -1)"
[ -n "$DOC_ID" ] || die "建文档没拿到 id：$(cat "$WORK/doc.json")"

ARC_CODE="$(curl -sS -o "$WORK/archive.json" -m 120 -w '%{http_code}' -b "$JAR" \
  -X POST "$BASE_URL/api/docs/${DOC_ID}/archive" -H 'Content-Type: application/json' \
  -d '{"note":"private bucket verification"}')"
[ "$ARC_CODE" = "200" ] || die "归档失败 HTTP ${ARC_CODE}：$(cat "$WORK/archive.json")"
TOKEN="$(sed -nE 's/.*"token":"([^"]+)".*/\1/p' "$WORK/archive.json" | head -1)"
[ -n "$TOKEN" ] || die "归档没拿到 token：$(cat "$WORK/archive.json")"
ok "已归档 doc_id=${DOC_ID} token=${TOKEN}"

# ── 5. 等过期：文档里那张图的签名必须已经失效 ─────────────
say "== 5/6 等文档里那张图的签名过期（签了 ${DOC_IMG_TTL}s）"
WAIT=$(( DOC_IMG_EXP - $(date +%s) + 6 ))
[ "$WAIT" -gt 0 ] && sleep "$WAIT"
EXPIRED_CODE="$(curl -sS -o /dev/null -m 15 -w '%{http_code}' -I "$DOC_SIGNED_URL")"
if [ "$EXPIRED_CODE" = "401" ] || [ "$EXPIRED_CODE" = "403" ]; then
  ok "原图签名已过期 → ${EXPIRED_CODE}（如果页面不做重签，图就该挂）"
else
  bad "原图签名过期后仍返回 ${EXPIRED_CODE}，验证前提不成立"
  FAILED=1
fi

# ── 6. GET /a/<token>：断言重签后的图片 URL HEAD 200 ──────
say "== 6/6 GET /a/${TOKEN} 断言图片已重签且可访问"
PAGE_CODE="$(curl -sS -o "$WORK/page.html" -m 30 -w '%{http_code}' "$BASE_URL/a/${TOKEN}")"
[ "$PAGE_CODE" = "200" ] || die "公开页打不开 HTTP ${PAGE_CODE}"
# HTML 里的 & 会被转义成 &amp;
PAGE_IMG="$(sed -e 's/&amp;/\&/g' "$WORK/page.html" | grep -oE "https?://[^\"' )]*${IMG_KEY//\//\\/}[^\"' )]*" | head -1)"
if [ -z "$PAGE_IMG" ]; then
  bad "页面里找不到图片 URL（原图 key=${IMG_KEY}），重签没生效：$(grep -o '![^)]*' "$WORK/page.html" | head -3)"
  FAILED=1
else
  ok "页面图片 URL：${PAGE_IMG:0:120}…"
  case "$PAGE_IMG" in
    *"?e="*) ok "带 e= 参数（有签名）" ;;
    *) bad "没有 e= 参数，说明私钥签名没加上"; FAILED=1 ;;
  esac
  NEW_E="$(printf '%s' "$PAGE_IMG" | sed -nE 's/.*[?&]e=([0-9]+).*/\1/p')"
  NOW="$(date +%s)"
  if [ -n "$NEW_E" ] && [ "$NEW_E" -gt "$NOW" ]; then
    ok "新 deadline 在未来（还差 $(( NEW_E - NOW ))s），是重签而不是沿用过期签名"
  else
    bad "新 deadline ${NEW_E:-缺失} 不在未来（now=${NOW}）"
    FAILED=1
  fi
  PAGE_HEAD="$(curl -sS -o /dev/null -m 20 -w '%{http_code}' -I "$PAGE_IMG")"
  if [ "$PAGE_HEAD" = "200" ]; then ok "页面图片 HEAD → 200"; else bad "页面图片 HEAD → ${PAGE_HEAD}"; FAILED=1; fi
fi

# ── 清理 ────────────────────────────────────────────────
if [ "$KEEP" = 0 ]; then
  say "== 清理测试文档与上传的探针图"
  curl -sS -o /dev/null -m 20 -b "$JAR" -X DELETE "$BASE_URL/api/docs/${DOC_ID}" ||
    say "  （测试文档 doc_id=${DOC_ID} 未删掉，可手动清）"
  ENTRY="$(printf '%s:%s' "$BUCKET" "$IMG_KEY" | b64url)"
  curl -sS -o /dev/null -m 20 -X POST "https://rs.qiniu.com/delete/${ENTRY}" \
    -H "Authorization: $(mgmt_auth "/delete/${ENTRY}")" ||
    say "  （删除失败，可手动清 ${BUCKET}:${IMG_KEY}）"
else
  say "== --keep：保留 ${IMG_KEY}"
fi

say ""
if [ "$FAILED" = 0 ]; then
  say "私有空间重签验收通过。"
  exit 0
fi
say "私有空间重签验收未通过，见上面 FAIL 行。"
exit 1
