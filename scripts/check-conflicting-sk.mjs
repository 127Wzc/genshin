import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID, randomInt } from 'node:crypto'

export const USERS = ['167352731', '2077739585', '3197519035', '3213825110', '3263500293', '3323714651', '383654257']
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const identity = r => JSON.stringify([String(r.stuid), r.stoken, r.ltoken, r.mid || ''])
const mapping = x => x && typeof x === 'object' && !Array.isArray(x)

// 仅使用仓库 bbsGetCookie 对应的米游社官方接口，不访问第三方服务。
export async function checkCredential(record, { fetchImpl = fetch, pause = sleep } = {}) {
  if (!record.stoken || !/^\d+$/.test(String(record.stuid))) return { state: 'unknown', reason: '缺少必要字段' }
  if (record.type === 'hoyolab' || !/cn_|_cn/.test(record.region || '') && record.type !== 'mys') {
    return { state: 'unknown', reason: '国际服或无法确认国服，不进行失效判定' }
  }
  const query = 'game_biz=hk4e_cn'
  const url = `https://api-takumi.mihoyo.com/auth/api/getCookieAccountInfoBySToken?${query}`
  async function probe() {
    const t = Math.round(Date.now() / 1000), r = randomInt(100000, 1000000)
    const digest = createHash('md5').update(`salt=xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs&t=${t}&r=${r}&b=&q=${query}`).digest('hex')
    try {
      const res = await fetchImpl(url, {
        redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: {
          Cookie: `stuid=${record.stuid};stoken=${record.stoken};mid=${record.mid || ''};ltoken=${record.ltoken || ''}`,
          'x-rpc-app_version': '2.73.1', 'x-rpc-client_type': '5', 'x-rpc-device_id': randomUUID(),
          'User-Agent': 'Mozilla/5.0 miHoYoBBS/2.73.1', Referer: 'https://act.mihoyo.com/', DS: `${t},${r},${digest}`
        }
      })
      if (!res.ok) return { state: 'unknown', reason: `HTTP ${res.status}` }
      const data = await res.json()
      const code = Number(data.retcode)
      if (code === 0 && data.data?.cookie_token) {
        const returnedId = data.data.uid ?? data.data.account_id
        if (returnedId != null && String(returnedId) !== String(record.stuid)) return { state: 'unknown', reason: '接口账号标识不一致' }
        return { state: 'valid', reason: 'Stoken 可换取 Cookie；不代表 ltoken 已单独验证' }
      }
      // 风控、限流、验证码、一般错误均不能用于删除绑定。
      if ([-1, -100, 1001, 10001, 10103].includes(code) && /(登录|login|stoken.*(失效|无效)|not.*log)/i.test(data.message || '')) {
        return { state: 'invalid', reason: `官方接口返回登录失效（retcode ${code}）` }
      }
      return { state: 'unknown', reason: `未能确定（retcode ${Number.isFinite(code) ? code : '缺失'}）` }
    } catch { return { state: 'unknown', reason: '请求超时、网络或响应异常' } }
  }
  const first = await probe()
  if (first.state !== 'invalid') return first
  await pause(1000)
  const second = await probe()
  return second.state === 'invalid' ? second : { state: 'unknown', reason: '两次登录失效检查结果不一致，保留记录' }
}

export function cleanedRecords(data, results) {
  const kept = Object.fromEntries(Object.entries(data).filter(([, value]) => results.get(identity(value))?.state !== 'invalid'))
  return { data: kept, removed: Object.keys(data).length - Object.keys(kept).length }
}

export async function main(args = process.argv.slice(2), { check = checkCredential, pause = sleep } = {}) {
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'), apply = false
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply') apply = true
    else if (args[i] === '--root' && args[i + 1]) root = path.resolve(args[++i])
    else if (['--help', '-h'].includes(args[i])) {
      console.log('用法：bash check-conflicting-sk.sh [--root Yunzai根目录] [--apply]\n仅检测固定七个源文件。默认只检测；--apply 备份后移除两次明确登录失效的记录。\n会向米游社官方接口发送候选凭据；不打印凭据，不修改 genshin 的目标绑定。\n此检测验证 Stoken 换取 Cookie 能力，不单独验证 ltoken。未知或多份有效凭据不会自动删除。\n实际写入前请先停止机器人。'); return
    } else throw new Error('参数错误，请使用 --help')
  }
  let YAML
  for (const base of [path.join(root, 'package.json'), fileURLToPath(import.meta.url)]) {
    try { YAML = createRequire(base)('yaml'); break } catch {}
  }
  if (!YAML) throw new Error('找不到 yaml 依赖，请在机器人环境执行')
  const source = path.join(root, 'plugins/xiaoyao-cvs-plugin/data/yaml')
  const folderStat = fs.lstatSync(source)
  if (!folderStat.isDirectory()) throw new Error('源账号目录不是普通目录，不操作软链接')
  console.log(`范围：固定七个逍遥 SK 文件；模式：${apply ? '检测并清理明确失效记录' : '只检测，不写入'}`)
  const files = []
  for (const qq of USERS) {
    const file = path.join(source, `${qq}.yaml`)
    if (!fs.existsSync(file)) { console.log(`${qq}.yaml：不存在，跳过`); continue }
    if (!fs.lstatSync(file).isFile()) throw new Error(`${qq}.yaml 不是普通文件`)
    const raw = fs.readFileSync(file, 'utf8')
    let data
    try { data = YAML.parse(raw) } catch { throw new Error(`${qq}.yaml YAML 格式错误（不显示原文）`) }
    if (!mapping(data) || Object.values(data).some(r => !mapping(r) || !r.stuid || r.userId != null && String(r.userId) !== qq)) {
      throw new Error(`${qq}.yaml 格式或用户归属异常，停止处理`)
    }
    files.push({ file, raw, data })
  }
  const plans = []
  for (const file of files) {
    const results = new Map(), representatives = new Map()
    for (const value of Object.values(file.data)) {
      const key = identity(value)
      const previous = representatives.get(key)
      if (!previous || !previous.region && value.region) representatives.set(key, value)
    }
    let index = 0
    for (const [key, record] of representatives) {
      // 同账号其他 UID 的国服标识可用于确定账号归属，不覆盖原始数据。
      const siblings = Object.values(file.data).filter(r => String(r.stuid) === String(record.stuid))
      const knownCn = siblings.some(r => r.type === 'mys' || /cn_|_cn/.test(r.region || ''))
      const knownOs = siblings.some(r => r.type === 'hoyolab' || r.region && !/cn_|_cn/.test(r.region))
      const candidate = !record.region && !record.type && knownCn && !knownOs ? { ...record, type: 'mys' } : record
      const result = await check(candidate)
      results.set(key, result)
      console.log(`${path.basename(file.file)} 候选 ${++index}：${result.state}，${result.reason}`)
      await pause(1000)
    }
    const cleaned = cleanedRecords(file.data, results)
    const survivors = new Map()
    for (const r of Object.values(cleaned.data)) {
      const group = survivors.get(String(r.stuid)) || new Set()
      group.add(identity(r)); survivors.set(String(r.stuid), group)
    }
    const remainingConflicts = [...survivors.values()].filter(group => group.size > 1).length
    console.log(`${path.basename(file.file)}：可移出 ${cleaned.removed} 条明确失效记录，剩余 ${remainingConflicts} 个账号仍有多份凭据`)
    if (cleaned.removed) plans.push({ ...file, text: YAML.stringify(cleaned.data) })
  }
  if (!apply || !plans.length) {
    console.log(apply ? '没有明确失效记录需要移除。' : '只检测结束。需实际清理时，停止机器人并加 --apply 重新检测。'); return
  }
  // 校验全部输入未发生变化，防止覆盖扫码或刷新产生的新数据。
  for (const file of files) if (fs.readFileSync(file.file, 'utf8') !== file.raw) throw new Error('检测期间数据发生变化，尚未写入，请停止机器人后重试')
  const backup = path.join(root, 'data/sk-check-backups', `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`)
  fs.mkdirSync(backup, { recursive: true, mode: 0o700 })
  for (const plan of plans) fs.writeFileSync(path.join(backup, path.basename(plan.file)), plan.raw, { mode: 0o600, flag: 'wx' })
  for (const plan of plans) {
    const tmp = `${plan.file}.${process.pid}.tmp`
    try { fs.writeFileSync(tmp, plan.text, { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, plan.file) }
    finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) }
  }
  console.log(`已清理 ${plans.length} 个文件，完整原文件备份：${backup}`)
  console.log('仅处理七个源文件中的明确失效记录；其他用户、genshin 绑定、Cookie 和 UID 均未修改。可重新运行迁移预览。')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('检查或写入失败，已停止；请检查参数、目录、YAML 和权限。如已开始写入，请查看 data/sk-check-backups 备份。不输出底层错误以免泄漏凭据。'); process.exitCode = 1 })
}
