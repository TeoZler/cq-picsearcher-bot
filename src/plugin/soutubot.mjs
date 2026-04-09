import { readFileSync } from 'fs';
import FormData from 'form-data';
import Axios from '../utils/axiosProxy.mjs';
import { flareSolverr } from '../utils/flareSolverr.mjs';
import logError from '../utils/logError.mjs';
import { retryAsync } from '../utils/retry.mjs';
import { confuseURL } from '../utils/url.mjs';

let hostsI = 0;

/** 缓存首页获取的 GLOBAL.m 值，{ host, m, expireAt } */
let globalMCache = null;

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * soutubot 搜索（基于 imsearch，专注 NH 本子搜索）
 *
 * @param {MsgImage} img 图片
 * @returns {{ success: boolean, msg: string }}
 */
async function doSearch(img) {
  const hosts = global.config.soutubotHost;
  const index = hostsI++;
  let host = hosts[index % hosts.length];
  if (!/^https?:\/\//.test(host)) host = `https://${host}`;

  let msg = '';
  let success = false;

  try {
    const result = await retryAsync(
      () => getSearchResult(host, img),
      3,
      e => e.code === 'ECONNRESET',
    );

    const data = result.data;

    if (!data || !data.data || data.data.length === 0) {
      msg = 'soutubot 未找到结果';
      return { success: false, msg };
    }

    const execTime = data.executionTime != null ? ` (耗时 ${data.executionTime}s)` : '';
    const lines = [`soutubot${execTime}`];
    const results = data.data.slice(0, 5); // 最多显示5条结果

    for (const item of results) {
      const similarity = item.similarity != null ? item.similarity.toFixed(2) : '?';
      const title = item.title || '无标题';
      const source = item.source || 'unknown';
      const page = item.page != null ? ` P${item.page}` : '';

      // 构建链接
      let pageUrl = '';
      if (item.pagePath) {
        const variant = getSourceVariant(source);
        pageUrl = `https://${variant.host}${item.pagePath}`;
      }

      const displayTitle = title.length > 40 ? title.slice(0, 40) + '...' : title;
      lines.push(`[${similarity}%] ${displayTitle}${page}`);

      if (pageUrl) {
        const displayUrl = global.config.bot.handleBannedHosts ? confuseURL(pageUrl) : pageUrl;
        lines.push(displayUrl);
      }
    }

    msg = lines.join('\n');
    success = true;
  } catch (e) {
    console.error('[error] soutubot');
    logError(e);
    const errMsg =
      (e.response && e.response.data && typeof e.response.data === 'string' && e.response.data.length < 200 && `\n${e.response.data}`) ||
      (e.response && e.response.data && e.response.data.message && `\n${e.response.data.message}`) ||
      (e.message && `\n${e.message}`) ||
      '';
    msg = `soutubot 搜索失败${errMsg}`;
  }

  return { success, msg };
}

/**
 * 根据来源返回对应的网站 host
 *
 * @param {string} source 来源标识 (nhentai, ehentai 等)
 * @returns {{ host: string }}
 */
function getSourceVariant(source) {
  const variants = {
    nhentai: { host: 'nhentai.net' },
    ehentai: { host: 'e-hentai.org' },
  };
  return variants[source] || { host: source };
}

/**
 * 从首页获取 GLOBAL.m 值（带缓存，10分钟过期）
 *
 * @param {string} host
 * @returns {Promise<number>}
 */
async function getGlobalM(host) {
  const now = Date.now();
  if (globalMCache && globalMCache.host === host && now < globalMCache.expireAt) {
    return globalMCache.m;
  }

  let html;
  if (global.config.flaresolverr.enableForSoutubot) {
    const ret = await flareSolverr.get(host);
    html = ret.data;
  } else {
    const ret = await Axios.get(host, {
      headers: { 'User-Agent': DEFAULT_UA },
      timeout: 15000,
    });
    html = ret.data;
  }

  const match = html.match(/m:\s*(-?\d+)/);
  const m = match ? parseInt(match[1], 10) : 0;

  globalMCache = { host, m, expireAt: now + 10 * 60 * 1000 };
  return m;
}

/**
 * 生成 X-API-KEY token
 *
 * @param {string} ua User-Agent
 * @param {number} m GLOBAL.m 值
 * @returns {string}
 */
function generateApiKey(ua, m) {
  const now = Math.floor(Date.now() / 1000);
  const raw = (Math.pow(now, 2) + Math.pow(ua.length, 2) + m).toString();
  return Buffer.from(raw).toString('base64').split('').reverse().join('').replace(/=/g, '');
}

/**
 * 发送搜索请求
 *
 * @param {string} host soutubot host
 * @param {MsgImage} img 图片
 */
async function getSearchResult(host, img) {
  const m = await getGlobalM(host);

  const ua =
    (global.config.flaresolverr.enableForSoutubot && flareSolverr.ua) || DEFAULT_UA;
  const token = generateApiKey(ua, m);

  const path = await img.getPath();
  if (!path) {
    throw new Error('无法获取图片路径');
  }

  const form = new FormData();
  form.append('file', readFileSync(path), { filename: 'image', contentType: 'image/jpeg' });
  form.append('factor', '1.2');

  const headers = {
    ...form.getHeaders(),
    'User-Agent': ua,
    'X-API-KEY': token,
    'X-Requested-With': 'XMLHttpRequest',
  };

  // 如果配置了 FlareSolverr，附加 cookie
  if (global.config.flaresolverr.enableForSoutubot) {
    const cookies = await flareSolverr.cookieJar.getCookies(host);
    if (cookies.length) {
      headers.Cookie = cookies.map(c => c.cookieString()).join('; ');
    }
  }

  return Axios.post(`${host}/api/search`, form, { headers, timeout: 30000 });
}

export default doSearch;
