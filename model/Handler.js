import common from '../../../lib/common/common.js'
import getDeviceFp from './getDeviceFp.js'
import MysApi from './mys/mysApi.js'
import fetch from 'node-fetch'
import Cfg from './Cfg.js'

export default class Handler {
  get apiCfg() {
    return Cfg.getConfig('api')
  }
  async getvali (e, mysApi, type, data = {}) {
    let res
    try {
      res = await mysApi.getData(type, data)
      if (res?.retcode == 0 || (type == 'detail' && res?.retcode == -1002)) return res

      if (![1034, 10035].includes(Number(res?.retcode)) || mysApi._gtVerify) return res
      res = await this.geetest(e, mysApi, Number(res.retcode))
      if (!res?.data?.challenge) {
        return { data: null, message: '验证码失败', retcode: res?.retcode }
      }

      // 不修改调用方的参数；验证凭证也保存在本次 MysApi 实例供后续接口使用。
      data = {
        ...data,
        headers: {
          ...data?.headers,
          'x-rpc-challenge': res.data.challenge,
          ...(res.data.validate ? {
            'x-rpc-validate': res.data.validate,
            'x-rpc-seccode': `${res.data.validate}|jordan`
          } : {})
        }
      }
      res = await mysApi.getData(type, data)

      logger.mark(`[genshin][GT-Manual] 验证后重发[api:${type}][retcode:${res?.retcode ?? '无响应'}]`)
      if (!(Number(res?.retcode) === 0 || (type == 'detail' && Number(res?.retcode) === -1002))) {
        return { data: null, message: '验证码失败', retcode: res?.retcode }
      }
    } catch (error) {
      logger.error(error)
      return { data: null, message: '出错了', retcode: res?.retcode }
    }
    return res
  }

  async geetest (e, data, retcode = 1034) {
    if (data._gtVerify) return { retcode: 0, data: data._gtVerify }
    // 同一请求实例的并发接口共用验证任务，不跨账号、跨游戏复用凭证。
    if (data._gtVerifying) return data._gtVerifying
    const task = this.runGeetest(e, data, Number(retcode))
    data._gtVerifying = task
    try {
      return await task
    } finally {
      delete data._gtVerifying
    }
  }

  async runGeetest (e, data, retcode) {
    let res
    const apiCfg = this.apiCfg
    const mode = Number(apiCfg.GtestType)
    let { uid, cookie, game } = data
    if (e?.game) game = e?.game
    let vali = new MysApi(uid, cookie, { ...data.option, game }, '', '', 'all')

    try {
      let challenge_game = game == 'zzz' ? '8' : game == 'sr' ? '6' : '2'
      let { deviceFp } = await getDeviceFp.Fp(uid, cookie, game)
      let headers = { 'x-rpc-device_fp': deviceFp, 'x-rpc-challenge_game': challenge_game }
      let app_key = game == 'zzz' ? 'game_record_zzz' : game == 'sr' ? 'hkrpg_game_record' : ''

      res = await vali.getData(retcode === 10035 ? 'createGeetest' : 'createVerification', { headers, app_key })
      if (!res || res?.retcode !== 0) {
        return { data: null, message: '未知错误，可能为cookie失效', retcode: 10103 }
      }

      const submit = async (validation) => {
        const challenge = validation.challenge || validation.geetest_challenge || res?.data?.challenge
        const validate = validation.validate || validation.geetest_validate
        const result = await vali.getData(retcode === 10035 ? 'verifyGeetest' : 'verifyVerification', {
          ...validation, challenge, validate, headers, app_key
        })
        if (Number(result?.retcode) === 0 && challenge && validate) {
          data._gtVerify = { challenge: result.data?.challenge || challenge, validate }
          logger.mark('[genshin][GT-Manual] 米游社验证提交成功')
          return { ...result, data: { ...result.data, ...data._gtVerify } }
        }
        return result
      }

      let test_nine = res
      let retry = 0
      if (apiCfg.type == 0) {
        if ([2, 1].includes(mode)) res = await vali.getData('test_nine', res?.data)
        if (res?.data?.validate) res = {
          data: {
            challenge: test_nine?.data?.challenge,
            validate: res?.data?.validate
          }
        }
      } else if (apiCfg.type == 1) {
        if ([2, 1].includes(mode)) res = await vali.getData('recognize', res?.data)
        if (res?.resultid) {
          let results = res
          await common.sleep(5000)
          res = await vali.getData('results', results)
          while ((res?.status == 2) && retry < 10) {
            await common.sleep(5000)
            res = await vali.getData('results', results)
            retry++
          }
        }
      } else if (apiCfg.type == 2) {
        if ([2, 1].includes(mode)) res = await vali.getData('in', res?.data)
        if (res?.request) {
          let request = res
          await common.sleep(5000)
          res = await vali.getData('res', request)
          while ((res?.request == 'CAPCHA_NOT_READY') && retry < 10) {
            await common.sleep(5000)
            res = await vali.getData('res', request)
            retry++
          }
        }
      }
      if (res?.data?.validate || res?.request?.geetest_validate) {
        res = await submit(res.data || res.request)
      } else {
        if ([2, 0].includes(mode)) {
          if (mode === 2) res = await vali.getData(retcode === 10035 ? 'createGeetest' : 'createVerification', { headers, app_key })
          res = await this.Manual_geetest(e, res?.data)
          if (res?.data?.validate || res?.data?.geetest_validate) {
            res = await submit(res.data)
          } else {
            return { data: null, message: '验证码失败', retcode: retcode }
          }
        } else {
          return { data: null, message: '验证码失败', retcode: retcode }
        }
      }

      if (res?.data?.challenge) return res
    } catch (error) {
      logger.error(error)
    }
    return { data: null, message: '验证码失败', retcode: retcode }
  }

  /** 沿用 GT-Manual 的回复方式，适配不返回消息 ID 的消息端。 */
  async reply(e, msg = '', quote = false, options = {}) {
    const fn = typeof e?._original_reply === 'function' ? e._original_reply : e?.reply
    if (typeof fn !== 'function') return false
    try {
      const res = await fn.call(e, msg, quote, options)
      return !(res === false || res?.error === true || res?.error?.length ||
        res?.status === 'failed' || (res?.retcode != null && Number(res.retcode) !== 0))
    } catch {
      logger.error('[genshin][GT-Manual] 消息发送失败，请检查消息适配器日志')
      return false
    }
  }

  /** 手动验证：同时兼容本地短轮询、外部服务长轮询及字符串结果。 */
  async Manual_geetest(e, data) {
    if (!data?.gt || !data?.challenge || !e) return false
    const cfg = this.apiCfg
    const fail = async message => {
      logger.error(`[genshin][GT-Manual] ${message}`)
      await this.reply(e, `米游社手动验证失败：${message}`)
      return false
    }
    if (!cfg.verifyAddr) return fail('未配置手动验证服务地址 verifyAddr')
    const request = async (url, options = {}, timeout = 10000) => {
      const res = await fetch(url, { ...options, signal: AbortSignal.timeout(timeout) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    }
    let registration
    try {
      logger.mark('[genshin][GT-Manual] 正在连接手动验证服务')
      registration = await request(cfg.verifyAddr, {
        method: 'post', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data)
      })
      if (!registration?.data?.link || !registration?.data?.result) {
        return fail('验证服务未返回验证链接或结果地址，请检查服务配置')
      }
    } catch {
      return fail('无法连接手动验证服务或请求超时，请检查 verifyAddr')
    }
    const sent = await this.reply(e, `米游社验证码\n${registration.data.link}`, true, { recallMsg: 90 })
    if (!sent) {
      logger.error('[genshin][GT-Manual] 验证链接发送失败，已停止等待')
      return false
    }
    logger.mark('[genshin][GT-Manual] 验证链接已提交发送，等待用户完成验证')
    const deadline = Date.now() + 120000
    const timeoutMessage = '等待验证超时，请重新发送查询指令并在两分钟内完成验证'
    try {
      while (Date.now() < deadline) {
        const result = await request(registration.data.result, {}, Math.max(1, deadline - Date.now()))
        const value = result?.data
        const validate = typeof value === 'string' ? value : value?.validate || value?.geetest_validate
        if (typeof validate === 'string' && validate) {
          logger.mark('[genshin][GT-Manual] 收到验证结果，继续米游社查询')
          return { ...result, data: {
            ...(typeof value === 'object' && value ? value : {}),
            challenge: value?.challenge || value?.geetest_challenge || data.challenge,
            validate
          } }
        }
        if (result?.status && result.message !== 'OK') return fail('验证信息已失效，请重新发送查询指令')
        await common.sleep(Math.max(0, Math.min(1500, deadline - Date.now())))
      }
    } catch (error) {
      if (Date.now() >= deadline || ['AbortError', 'TimeoutError'].includes(error.name)) return fail(timeoutMessage)
      return fail('读取验证结果失败，请检查验证服务的结果地址是否可从机器人访问')
    }
    return fail(timeoutMessage)
  }
}
