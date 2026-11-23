/**
 * 项目相关链接（纯静态配置，不发网络请求；点击才会在新标签页打开）
 * - SPONSOR_LINKS: 可选自愿支持链接（url 为空则不显示，可按需添加/填写 Ko-fi、GitHub Sponsors 等）
 * - PROJECT_URL: 项目主页
 * - SUPPORT_URL: 问题反馈/支持页
 */
export const SPONSOR_LINKS = [
  { url: 'https://ifdian.net/a/fbread', label: '爱发电' },
  { url: 'https://ko-fi.com/fbread', label: 'Ko-fi' },
  // GitHub Sponsors 需要 Stripe 收款（不支持中国大陆银行账户），暂不开通；
  // 以后若开通，加一行 { url: 'https://github.com/sponsors/<用户名>', label: 'GitHub Sponsors' } 即可
];
export const PROJECT_URL = 'https://github.com/wstszx/chrome-local-translate';
export const SUPPORT_URL = 'https://github.com/wstszx/chrome-local-translate/issues';