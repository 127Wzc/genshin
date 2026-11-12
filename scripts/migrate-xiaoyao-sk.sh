#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
command -v node >/dev/null 2>&1 || { echo '需要 Node.js，请在机器人运行环境执行。' >&2; exit 1; }
node --input-type=module - "$SCRIPT_DIR" "$@" <<'JS'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const [scriptDir, ...args] = process.argv.slice(2)
let root = path.resolve(scriptDir, '../../..')
let apply = false, preferSource = false
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--apply') apply = true
  else if (args[i] === '--prefer-source') preferSource = true
  else if (args[i] === '--root' && args[i + 1]) root = path.resolve(args[++i])
  else if (args[i] === '--help' || args[i] === '-h') {
    console.log(`用法：bash migrate-xiaoyao-sk.sh [--root Yunzai目录] [--apply] [--prefer-source]
默认仅检查插件引用并预览迁移，不修改文件。
--apply          备份后迁移；保留逍遥原文件，不自动同步、不修改其他插件。
--prefer-source  同账号内容不同则采用逍遥数据；默认保留 genshin 数据。
请先停止机器人，迁移完成后再启动，避免扫码或刷新凭据时并发写入。`)
    process.exit(0)
  } else { console.error('参数错误，请使用 --help。'); process.exit(1) }
}
let YAML
try {
  YAML = createRequire(path.join(root, 'package.json'))('yaml')
} catch {
  try { YAML = createRequire(path.join(scriptDir, '../package.json'))('yaml') }
  catch { console.error('找不到 yaml 依赖，请在已安装依赖的 Yunzai 环境执行。'); process.exit(1) }
}
const plugins = path.join(root, 'plugins')
const source = path.join(plugins, 'xiaoyao-cvs-plugin/data/yaml')
const target = path.join(plugins, 'genshin/yaml')
const relative = p => path.relative(root, p)
const regularDir = p => fs.existsSync(p) && fs.lstatSync(p).isDirectory()
if (!regularDir(plugins) || !regularDir(path.dirname(target))) {
  console.error('未找到 Yunzai/plugins/genshin，请通过 --root 指定 Yunzai 根目录。'); process.exit(1)
}
console.log(`模式：${apply ? '实际迁移' : '预览（不写入）'}；同账号冲突：${preferSource ? '采用逍遥数据' : '保留 genshin 数据'}`)
console.log('\n插件引用检查（候选位置，需人工确认；不自动改路径）：')
const excluded = new Set(['node_modules', '.git', 'resources', 'data', 'yaml', 'config', 'logs', 'temp', 'dist', 'build', 'scripts'])
const audit = { own: 0, other: 0 }
function scan(dir, plugin = '') {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, ent.name)
    if (ent.isDirectory() && !excluded.has(ent.name)) scan(file, plugin || ent.name)
    else if (ent.isFile() && /\.(?:[cm]?js|ts)$/.test(ent.name)) {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
      lines.forEach((line, i) => {
        if (!/xiaoyao-cvs-plugin|getUserStoken|getBingStoken|saveBingStoken/.test(line)) return
        const own = plugin === 'xiaoyao-cvs-plugin'
        audit[own ? 'own' : 'other']++
        console.log(`  ${relative(file)}:${i + 1} [${own ? '逍遥自身' : '其他插件，检查是否读取 SK 或仅引用名称'}]`)
      })
    }
  }
}
scan(plugins)
console.log(`引用行数：逍遥自身 ${audit.own}，其他插件 ${audit.other}。动态路径或其他语言可能漏检，不能据此保证全部兼容。`)
if (!regularDir(source)) { console.error(`\n未找到源目录：${relative(source)}，未迁移。`); process.exit(1) }
if (fs.existsSync(target) && !regularDir(target)) { console.error('目标目录不是普通目录，请人工检查。'); process.exit(1) }
const mapping = x => x && typeof x === 'object' && !Array.isArray(x)
class MigrationError extends Error {}
function read(file) {
  if (!fs.lstatSync(file).isFile()) throw new MigrationError('不是普通文件（不接受软链接）')
  const raw = fs.readFileSync(file, 'utf8')
  let data
  try { data = YAML.parse(raw) }
  catch { throw new MigrationError('YAML 语法错误或重复键，请在本机检查原文件') }
  if (!mapping(data)) throw new MigrationError('文件不是账号映射格式（为空、数组或旧单条格式）')
  return { raw, data }
}
function accounts(data, qq) {
  const result = new Map()
  result.duplicates = 0
  for (const item of Object.values(data)) {
    if (!mapping(item)) throw new MigrationError('账号记录不是对象')
    if (!/^\d+$/.test(String(item.stuid))) throw new MigrationError('stuid 缺失或格式错误')
    if (!item.stoken) throw new MigrationError('缺少 stoken')
    if (!item.ltoken) throw new MigrationError('缺少 ltoken')
    if (item.userId != null && String(item.userId) !== qq) throw new MigrationError('记录的 userId 与文件名不一致')
    const key = String(item.stuid)
    const record = { ...item, userId: item.userId ?? qq }
    const previous = result.get(key)
    if (previous) {
      // 逍遥按游戏 UID 保存；同一米游社账号可在一个文件中出现多次。
      // 不同凭据无法判断新旧，不能任意选择；仅折叠凭据一致的记录。
      for (const field of ['stoken', 'ltoken', 'mid']) {
        if (previous[field] && record[field] && String(previous[field]) !== String(record[field])) {
          throw new MigrationError('同一 stuid 存在不同凭据，无法判断新旧；请整理该账号记录后重试')
        }
      }
      // 优先保留带区服的代表记录，不把不同游戏的 UID、区服任意拼接。
      const chosen = !previous.region && record.region ? record : previous
      const other = chosen === record ? previous : record
      const merged = { ...chosen }
      if (!merged.mid && other.mid) merged.mid = other.mid
      result.set(key, merged)
      result.duplicates++
    } else result.set(key, record)
  }
  return result
}
const equal = (a, b) => {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
  return keys.every(k => JSON.stringify(a[k]) === JSON.stringify(b[k]))
}
const plans = []
let errors = 0, conflicts = 0, added = 0, unchanged = 0
console.log('\n迁移预览：')
for (const name of fs.readdirSync(source).sort()) {
  const match = /^([A-Za-z0-9_-]+)\.yaml$/.exec(name)
  if (!match) { console.log(`  跳过非用户 YAML 文件：${name}`); continue }
  const src = path.join(source, name), dst = path.join(target, name)
  let stage = '源文件'
  try {
    const srcFile = read(src)
    const incoming = accounts(srcFile.data, match[1])
    stage = '目标文件'
    const old = fs.existsSync(dst) ? read(dst) : null
    const merged = old ? accounts(old.data, match[1]) : new Map()
    if (incoming.duplicates) console.log(`  ${name}：源文件同账号多 UID 记录折叠 ${incoming.duplicates} 条（凭据一致）`)
    if (merged.duplicates) console.log(`  ${name}：目标文件同账号多 UID 记录折叠 ${merged.duplicates} 条（凭据一致）`)
    const missingRegion = [...incoming.values()].filter(record => !record.region).length
    if (missingRegion) console.log(`  ${name}：提示 ${missingRegion} 个账号缺少 region；可迁移凭据，但 genshin 社区签到会过滤无区服记录，建议后续重新扫码补全`)
    stage = '合并处理'
    let newCount = 0, conflictCount = 0, changed = false
    for (const [id, record] of incoming) {
      if (!merged.has(id)) { merged.set(id, record); newCount++; changed = true }
      else if (!equal(merged.get(id), record)) {
        conflictCount++
        if (preferSource) { merged.set(id, record); changed = true }
      }
    }
    added += newCount; conflicts += conflictCount
    if (changed) {
      plans.push({ dst, old, src, srcRaw: srcFile.raw, text: YAML.stringify(Object.fromEntries(merged)) })
      console.log(`  ${name}：新增 ${newCount} 个账号，冲突 ${conflictCount} 个${preferSource ? '（采用源）' : '（保留目标）'}`)
    } else { unchanged++; console.log(`  ${name}：无需写入，冲突 ${conflictCount} 个（${preferSource ? '采用源' : '保留目标'}）`) }
  } catch (error) {
    // 不打印解析器错误正文，避免 YAML 异常将凭据原文带入日志。
    const reason = error instanceof MigrationError ? error.message : '文件读取或处理失败，请检查文件权限（不显示底层错误原文）'
    errors++; console.error(`  ${name}：${stage}校验失败：${reason}（不显示凭据）`)
  }
}
console.log(`计划写入 ${plans.length} 个文件，新增 ${added} 个账号，冲突 ${conflicts} 个，无需写入 ${unchanged} 个文件，异常 ${errors} 个。`)
if (errors) { console.error('存在异常文件，本次不执行任何迁移；修复后重试。'); process.exit(2) }
if (!apply) { console.log('确认后加 --apply 执行；请先停止机器人。'); process.exit(0) }
if (!plans.length) { console.log('无需迁移。'); process.exit(0) }
// 写入前再次确认所有已读取文件未变化，避免预览期间账号数据更新。
for (const plan of plans) {
  if (fs.readFileSync(plan.src, 'utf8') !== plan.srcRaw ||
      (plan.old ? !fs.existsSync(plan.dst) || fs.readFileSync(plan.dst, 'utf8') !== plan.old.raw : fs.existsSync(plan.dst))) {
    console.error('检查期间数据发生变化，请停止机器人后重试；尚未写入。'); process.exit(2)
  }
}
const backup = path.join(root, 'data/genshin-sk-migration-backups', `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`)
fs.mkdirSync(backup, { recursive: true, mode: 0o700 })
const manifest = { target: relative(target), created: [], replaced: [] }
// 全部目标先备份，再逐文件原子替换；源目录始终保留。
for (const plan of plans) {
  const name = path.basename(plan.dst)
  if (plan.old) { fs.writeFileSync(path.join(backup, name), plan.old.raw, { mode: 0o600, flag: 'wx' }); manifest.replaced.push(name) }
  else manifest.created.push(name)
}
fs.writeFileSync(path.join(backup, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600, flag: 'wx' })
fs.mkdirSync(target, { recursive: true, mode: 0o700 })
for (const plan of plans) {
  const tmp = `${plan.dst}.migration-${process.pid}.tmp`
  try { fs.writeFileSync(tmp, plan.text, { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, plan.dst) }
  finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) }
}
console.log(`迁移完成，备份与文件清单：${backup}`)
console.log('原文件保留。这是一次性迁移；后续逍遥扫码不会自动同步。启动机器人后验证扫码、刷新 CK 和签到。')
JS
