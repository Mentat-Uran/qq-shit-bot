const THEME_STORAGE_KEY = "qqbot-ops-theme";
const state = { snapshot: null, activeSection: "dashboard", theme: "dark" };

const sectionMeta = {
  dashboard: ["运行面板 / 01", "总览"],
  runtime: ["运行面板 / 02", "运行与资源"],
  activity: ["运行面板 / 03", "QQ 活动"],
  sessions: ["运行面板 / 04", "会话与上下文"],
  logs: ["运行面板 / 05", "日志与诊断"],
};

const labels = {
  operational: "运行正常",
  degraded: "降级",
  unknown: "未知",
  running: "运行中",
  active: "活动",
  idle: "空闲",
  stopped: "已停止",
  exited: "已退出",
  healthy: "健康",
  unhealthy: "不健康",
  connected: "已连接",
  disconnected: "已断开",
  starting: "启动中",
  available: "可用",
  unavailable: "不可用",
  not_configured: "未配置",
  not_collected: "未采集",
  not_applicable: "不适用",
  configured: "已配置",
};

const confidenceLabels = {
  direct: "直接采集",
  inferred: "日志推断",
  not_collected: "未采集",
};

const levelLabels = { error: "错误", warn: "警告", warning: "警告", info: "信息" };

const eventTypeLabels = {
  qq_connection: "QQ 连接",
  qq_inbound: "QQ 入站",
  model_request: "模型请求",
  qq_reply: "QQ 回复",
  context_recovery: "上下文恢复",
};

const eventPhaseLabels = {
  connected: "已连接",
  disconnected: "已断开",
  received: "已接收",
  skipped: "已跳过",
  started: "已开始",
  succeeded: "已成功",
  sent: "已发送",
  overflow: "上下文溢出",
  stalled: "处理停滞",
  reset: "已重置",
};

const sourceLabels = {
  "host CPU": "主机 CPU",
  "host memory": "主机内存",
  "host disk": "主机磁盘",
  "Windows GlobalMemoryStatusEx": "Windows 内存状态",
  "Windows GetSystemTimes": "Windows 系统时间",
  "macOS ps process CPU": "macOS 进程 CPU",
  "macOS sysctl/vm_stat": "macOS 内存状态",
  os: "系统负载",
  "os.getloadavg": "系统负载",
  "deploy/openclaw/runtime/model-route-state.json": "模型路由状态文件",
  "docker info": "Docker 信息",
  "docker compose": "Docker Compose",
  "docker compose ps --all": "Docker Compose 服务状态",
  "docker stats MEM USAGE; system RAM, not GPU VRAM": "Docker stats · 系统 RAM（不是 GPU VRAM）",
  "docker compose logs --tail 80": "Docker Compose 日志尾部",
  "OpenClaw runtime queue": "OpenClaw 运行时队列",
  "OpenClaw state SQLite queue tables": "OpenClaw 状态队列表",
  "deploy/openclaw/runtime/config/agents/main/sessions/*.jsonl 元数据": "OpenClaw 会话元数据",
  "deploy/openclaw/runtime/config/agents/main/sessions/*.jsonl": "OpenClaw 会话元数据",
  "deploy/openclaw/openclaw.json": "OpenClaw 配置文件",
  "deploy/openclaw/openclaw.mac.json": "OpenClaw Mac 配置文件",
  "macOS SenseNova cloud vision": "SenseNova 云视觉（Mac）",
  "nvidia-smi on host": "主机 nvidia-smi",
  "nvidia-smi via qwen-vision": "qwen-vision 内 nvidia-smi",
  "nvidia-smi / qwen-vision": "nvidia-smi / qwen-vision",
  "ollama ps via qwen-vision": "qwen-vision 内 Ollama",
  "OpenClaw /healthz on loopback": "本机 OpenClaw /healthz",
  "gateway log pattern": "网关日志模式",
  "structured local event model": "本地结构化事件模型",
  "structured local session model": "本地结构化会话模型",
  "OpenClaw session adapter": "OpenClaw 会话适配器",
  "model route state": "模型路由状态",
  "local console snapshot": "本机控制台快照",
  "console snapshot": "控制台快照",
};

const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? "未知").replace(/[&<>"']/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[char]));
const statusLabel = (value) => labels[value] || value || "未知";
const confidenceLabel = (value) => confidenceLabels[value] || value || "未知";
const levelLabel = (value) => levelLabels[value] || value || "信息";
const sourceLabel = (value) => sourceLabels[value] || value || "来源未采集";
const eventTypeLabel = (value) => eventTypeLabels[value] || value || "事件";
const eventPhaseLabel = (value) => eventPhaseLabels[value] || value || "阶段未知";
const channelLabel = (value) => value === "group" ? "群聊" : value === "direct" ? "私聊" : "渠道未知";
const statusClass = (value) => String(value || "unknown").toLowerCase().replace(/[^a-z0-9_-]/g, "unknown");
const number = (value, suffix = "") => value === null || value === undefined || Number.isNaN(Number(value)) ? "未知" : `${Number(value).toLocaleString("zh-CN", {maximumFractionDigits: 1})}${suffix}`;
const bytes = (value) => {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "未知";
  const units = ["B", "KB", "MB", "GB", "TB"]; let amount = Number(value); let index = 0;
  while (amount >= 1024 && index < units.length - 1) { amount /= 1024; index += 1; }
  return `${amount.toLocaleString("zh-CN", {maximumFractionDigits: 1})} ${units[index]}`;
};
const time = (value) => value ? new Date(value).toLocaleTimeString("zh-CN", {hour: "2-digit", minute: "2-digit", second: "2-digit"}) : "未知";
const evidenceText = (value) => value?.source ? `来源：${sourceLabel(value.source)} · 可信度：${confidenceLabel(value.confidence)}` : "来源未采集";
const meter = (value, color = "") => {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return `<div class="meter meter-unknown ${color}" aria-label="未采集"><span></span></div>`;
  const percent = Math.max(0, Math.min(100, Number(value)));
  const bucket = Math.round(percent / 5) * 5;
  return `<div class="meter ${color} w-${bucket}" aria-label="${number(percent, "%")}"><span></span></div>`;
};

function readTheme() {
  try { return localStorage.getItem(THEME_STORAGE_KEY) === "light" ? "light" : "dark"; } catch { return "dark"; }
}

function applyTheme(theme, persist = false) {
  state.theme = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = state.theme;
  const light = state.theme === "light";
  const button = $("#theme-toggle");
  if (button) {
    button.setAttribute("aria-pressed", String(light));
    button.setAttribute("aria-label", light ? "切换到深色模式" : "切换到浅色模式");
    $("#theme-toggle-label").textContent = light ? "深色模式" : "浅色模式";
    $(".theme-icon").textContent = light ? "☾" : "☼";
  }
  if (persist) {
    try { localStorage.setItem(THEME_STORAGE_KEY, state.theme); } catch { /* 本地存储不可用时仍保持当前页面主题 */ }
  }
}

function renderServices(services) {
  $("#service-cards").innerHTML = services.map((service) => `<article class="service-card"><div class="service-top"><span class="service-name">${esc(service.service)}</span><span class="service-state"><i class="status-dot ${statusClass(service.status)}"></i>${esc(statusLabel(service.status))}</span></div><div class="service-meta"><div><span>运行态</span>${esc(statusLabel(service.state))}</div><div><span>健康状态</span>${esc(statusLabel(service.health))}</div><div><span>观测时间</span>${esc(time(service.observedAt))}</div><div><span>数据来源</span>${esc(sourceLabel(service.source))}</div></div></article>`).join("");
  $("#service-table").innerHTML = services.map((service) => `<tr><td>${esc(service.service)}</td><td><span class="table-status ${statusClass(service.status)}">${esc(statusLabel(service.status))}</span></td><td><span class="table-status ${statusClass(service.health)}">${esc(statusLabel(service.health))}</span></td><td>${bytes(service.resources?.memoryBytes)}</td><td>${esc(sourceLabel(service.source))}</td></tr>`).join("");
}

function renderResources(snapshot) {
  const host = snapshot.dashboard.host || {}; const gpu = snapshot.dashboard.gpu || {}; const docker = snapshot.runtime.docker || {};
  const hostRam = host.memory || {}; const disk = host.disk || {}; const cpu = host.cpu || {};
  const mac = snapshot.deployment === "mac";
  $("#resource-list").innerHTML = [
    ["主机 CPU", number(cpu.percent, "%"), cpu.percent, "", evidenceText(cpu)],
    ["主机 RAM", `${bytes(hostRam.usedBytes)} / ${bytes(hostRam.totalBytes)}`, hostRam.usedPercent, "mint", evidenceText(hostRam)],
    ["Docker RAM", bytes(docker.systemRam?.bytes), docker.systemRam?.bytes && docker.systemRam.bytes > 0 ? Math.min(100, (docker.systemRam.bytes / Math.max(1, hostRam.totalBytes || docker.systemRam.bytes)) * 100) : null, "cyan", "来源：Docker stats · 系统 RAM（不是 GPU VRAM）"],
    [mac ? "GPU VRAM（不适用）" : "GPU VRAM", mac ? "不适用" : `${bytes(gpu.vramUsedBytes)} / ${bytes(gpu.vramTotalBytes)}`, mac ? null : gpu.vramTotalBytes ? (gpu.vramUsedBytes / gpu.vramTotalBytes) * 100 : null, "", evidenceText(gpu)],
  ].map(([label, value, percent, color, source]) => `<div class="resource-item"><div class="resource-item-head"><span>${esc(label)}</span><strong class="resource-value">${esc(value)}</strong></div>${meter(percent, color)}<span class="eyebrow">${esc(source)}</span></div>`).join("");
  $("#runtime-resource-cards").innerHTML = [
    ["主机 CPU", number(cpu.percent, "%"), evidenceText(cpu), cpu.percent],
    ["主机 RAM", `${bytes(hostRam.usedBytes)} / ${bytes(hostRam.totalBytes)}`, `${number(hostRam.usedPercent, "%")} · ${evidenceText(hostRam)}`, hostRam.usedPercent],
    ["Docker 系统 RAM", bytes(docker.systemRam?.bytes), "来源：Docker stats MEM USAGE · 不是 VRAM", docker.systemRam?.bytes && hostRam.totalBytes ? docker.systemRam.bytes / hostRam.totalBytes * 100 : null],
    [mac ? "GPU VRAM（不适用）" : "GPU VRAM", mac ? "不适用" : `${bytes(gpu.vramUsedBytes)} / ${bytes(gpu.vramTotalBytes)}`, mac ? `Mac 使用 SenseNova 云视觉 · ${evidenceText(gpu)}` : `${gpu.name || "GPU 未知"} · ${evidenceText(gpu)}`, mac ? null : gpu.vramTotalBytes ? gpu.vramUsedBytes / gpu.vramTotalBytes * 100 : null],
  ].map(([label, value, source, percent]) => `<article class="resource-card"><p class="eyebrow">${esc(label)}</p><h4>${esc(value)}</h4>${meter(percent)}<small>${esc(source)}</small></article>`).join("");
  $("#route-meta").dataset.disk = disk.status || "unknown";
  $("#route-meta").title = `磁盘：${bytes(disk.usedBytes)} / ${bytes(disk.totalBytes)}`;
  $("#context-tokens").textContent = snapshot.sessions.contextTokens?.status === "available" ? number(snapshot.sessions.contextTokens.value) : "未采集";
  renderSessionGuards(snapshot);
}

function renderSessionGuards(snapshot) {
  const sessions = snapshot.sessions || {};
  const config = sessions.compactionConfiguration || {};
  const contextConfig = sessions.contextTokenConfiguration || {};
  const contextTokens = sessions.contextTokens || {};
  const configAvailable = config.status === "available";
  const recovery = sessions.recovery || {};
  $("#context-tokens-note").textContent = contextTokens.status === "available" && contextTokens.kind === "recent_request_input"
    ? `最近一次模型输入 · 不等于当前占用 · 配置上限 ${number(contextConfig.value)} Token`
    : contextConfig.status === "available" ? `配置上限 ${number(contextConfig.value)} Token · 当前占用未接入` : "当前会话占用未接入";
  $("#session-recovery").textContent = configAvailable ? `${config.compactionMode === "safeguard" ? "安全压缩" : config.compactionMode || "已配置"}` : "未采集";
  $("#session-recovery-note").textContent = configAvailable
    ? `${recovery.status === "available" ? `日志发现 ${recovery.eventCount || 0} 次恢复事件` : "日志尾部未发现恢复事件"} · 保留最近 ${config.compactionRecentTurnsPreserve ?? "未知"} 轮`
    : "运行配置未读取";
  const currentQueue = snapshot.activity?.queueLength || {};
  $("#session-queue").textContent = currentQueue.status === "available" ? `当前 ${number(currentQueue.value)} 条` : configAvailable ? "汇聚" : "未采集";
  $("#session-queue-note").textContent = configAvailable
    ? `配置上限 ${number(config.queueCap)} 条 · 汇聚等待 ${number(config.queueDebounceMs)} ms · ${currentQueue.status === "available" ? "状态数据库直读" : "当前长度未接入"}`
    : "运行配置未读取";
}

function renderErrors(records, target) {
  const list = records || [];
  $(target).innerHTML = list.length ? list.slice(-5).reverse().map((record) => `<div class="error-entry"><i class="severity ${statusClass(record.level)}"></i><span class="error-summary">${esc(record.summary)}</span><span class="error-service">${esc(record.service)} · ${esc(time(record.observedAt))}</span></div>`).join("") : `<div class="empty-state compact"><strong>暂无可确认错误</strong><p>日志为空或采集未完成，不代表服务一定正常。</p></div>`;
}

function renderActivity(snapshot) {
  const activity = snapshot.activity || {}; const connection = activity.connection || {};
  $("#activity-queue").textContent = activity.queueLength?.status === "available" ? `${number(activity.queueLength.value)} 条` : "未采集";
  const queueConfig = activity.queueConfiguration || {};
  $("#activity-queue-note").textContent = queueConfig.status === "available"
    ? `${activity.queueLength?.status === "available" ? "状态数据库直读" : "当前长度未接入"} · 配置上限 ${number(queueConfig.queueCap)} 条`
    : "不把消息条数冒充当前 Token";
  $("#activity-connection").textContent = statusLabel(connection.status);
  $("#activity-connection-source").textContent = evidenceText(connection);
  const eventCollection = activity.eventCollection || {};
  $("#activity-event-source").textContent = eventCollection.status === "available" ? "日志推断" : "未采集";
  $("#activity-event-source-note").textContent = eventCollection.status === "available"
    ? `已提取 ${number(eventCollection.eventCount)} 条脱敏事件`
    : eventCollection.detail || "固定日志模式推断，不是事件桥";
  const timeline = $("#activity-timeline"); const empty = $("#activity-empty");
  if (activity.events?.length) {
    empty.style.display = "none";
    timeline.style.display = "grid";
    timeline.innerHTML = activity.events.slice().reverse().map((event) => `<div class="timeline-entry"><strong>${esc(eventTypeLabel(event.type))}</strong><span>${esc(eventPhaseLabel(event.phase))}${event.channel ? ` · ${esc(channelLabel(event.channel))}` : ""}${event.model ? ` · ${esc(event.model)}` : ""}</span><time>${esc(time(event.observedAt))}</time><small>日志推断 · ${esc(event.service || "服务未知")}</small></div>`).join("");
  } else {
    empty.style.display = "grid";
    timeline.style.display = "none";
  }
  const sessions = snapshot.sessions?.sessions || [];
  const sessionSummary = snapshot.sessions?.summary || {};
  $("#session-summary").textContent = sessionSummary.status === "available"
    ? `${number(sessionSummary.activeCount)} 个活动 · 显示 ${number(sessionSummary.returnedCount ?? sessions.length)} 条`
    : statusLabel(sessionSummary.status);
  $("#session-table").innerHTML = sessions.map((session) => `<tr><td>${esc(session.id)}</td><td>${esc(statusLabel(session.status))}</td><td>${esc(time(session.lastActivityAt))}</td><td>${esc(session.queueLength ?? "未采集")}</td><td>${esc(session.contextTokens === null || session.contextTokens === undefined ? "未采集" : number(session.contextTokens))}</td></tr>`).join("");
  $("#session-empty").style.display = sessions.length ? "none" : "grid";
}

function renderLogs(snapshot) {
  const records = snapshot.logs?.records || []; const retention = snapshot.logs?.retention || {};
  $("#log-status").textContent = statusLabel(snapshot.logs?.status?.status);
  $("#log-retention").textContent = `尾部 ${retention.tailLines ?? 80} 行 / 最多 ${retention.maxRecords ?? 80} 条记录`;
  $("#log-list").innerHTML = records.length ? records.slice().reverse().map((record) => `<div class="log-entry"><span class="log-level ${statusClass(record.level)}">${esc(levelLabel(record.level))}</span><span class="log-service">${esc(record.service)}</span><span class="log-time">${esc(time(record.observedAt))}</span><span class="log-summary">${esc(record.summary)}</span></div>`).join("") : `<div class="empty-state"><span class="empty-mark">∅</span><strong>日志为空或不可达</strong><p>控制台仍保持可用；当前没有足够证据判断日志对应的运行状态。</p></div>`;
}

function render(snapshot) {
  state.snapshot = snapshot;
  const dashboard = snapshot.dashboard || {}; const status = dashboard.status || "unknown";
  const mac = snapshot.deployment === "mac";
  $("#overall-status").textContent = statusLabel(status);
  $("#overall-status").style.color = status === "operational" ? "var(--mint)" : status === "degraded" ? "var(--amber)" : "var(--ink)";
  $("#overall-stamp").textContent = statusLabel(status);
  $("#overall-detail").textContent = dashboard.detail || "运行证据不足";
  $("#last-refresh").textContent = `最后刷新 ${time(dashboard.lastRefreshAt || snapshot.observedAt)}`;
  renderServices(dashboard.services || []);
  renderResources(snapshot);
  renderErrors(dashboard.recentErrors, "#dashboard-errors");
  const route = dashboard.modelRoute || {};
  $("#route-chip").textContent = statusLabel(route.status);
  $("#route-primary").textContent = route.primary || "未采集";
  $("#route-fallback").textContent = route.fallback || "未采集";
  $("#route-meta").textContent = route.status === "available"
    ? `${route.route || "路由未知"} · ${route.lastProbeAt ? `探测时间 ${time(route.lastProbeAt)}` : "仅配置值，未执行可用性探测"}`
    : route.detail || "没有可用的模型路由证据";
  $("#vision-label").textContent = mac ? "SenseNova 云视觉 / 当前模型" : "本地视觉 / 当前模型";
  $("#ollama-model").textContent = mac ? "sensenova-6.7-flash-lite" : dashboard.ollama?.currentModel || "未采集";
  $("#ollama-source").textContent = mac ? "图片识别结果交给 DeepSeek 文本模型；GPU/本地模型不适用" : dashboard.ollama?.status === "available" ? evidenceText(dashboard.ollama) : dashboard.ollama?.detail || "视觉模式未采集";
  const consoleInfo = snapshot.console || {};
  const lanAccess = consoleInfo.bind && !["127.0.0.1", "::1", "localhost"].includes(consoleInfo.bind);
  $("#access-badge").textContent = lanAccess ? "受保护 LAN 访问" : "仅本机访问";
  $("#access-detail").innerHTML = `监听 ${esc(consoleInfo.bind || "未知")} : ${esc(consoleInfo.port || "未知")}<br>浏览器不接触 Docker socket`;
  const websocket = dashboard.websocket || {};
  $("#qq-chip").textContent = statusLabel(websocket.status);
  $("#qq-connection").textContent = statusLabel(websocket.status);
  $("#recent-event").textContent = time(dashboard.recentEventAt);
  $("#recent-request").textContent = time(dashboard.recentModelRequestAt);
  $("#recent-reply").textContent = time(dashboard.recentSuccessfulReplyAt);
  $("#control-ui-link").href = snapshot.operations?.gatewayUrl || "http://127.0.0.1:18789/";
  renderActivity(snapshot); renderLogs(snapshot);
}

async function fetchSnapshot(force = false) {
  const button = $("#refresh-button"); button.disabled = true;
  try {
    const response = force ? await fetch("/api/refresh", {method: "POST"}) : await fetch("/api/snapshot");
    if (!response.ok) throw new Error("snapshot unavailable");
    render(await response.json());
    $("#page-notice").classList.remove("notice-error");
  } catch (error) {
    $("#page-notice").classList.add("notice-error");
    $("#page-notice").lastElementChild.textContent = "控制台 API 暂时不可达；页面保留在本机，下一轮会自动重试。";
  } finally { button.disabled = false; }
}

function activate(section) {
  if (!sectionMeta[section]) return;
  state.activeSection = section;
  document.querySelectorAll(".nav-item").forEach((item) => {
    const active = item.dataset.section === section;
    item.classList.toggle("is-active", active);
    if (active) item.setAttribute("aria-current", "page"); else item.removeAttribute("aria-current");
  });
  document.querySelectorAll(".page-section").forEach((page) => page.classList.toggle("is-visible", page.dataset.page === section));
  $("#section-kicker").textContent = sectionMeta[section][0]; $("#section-title").textContent = sectionMeta[section][1];
}

async function copyDiagnostics() {
  if (!state.snapshot) return;
  const text = JSON.stringify(state.snapshot, null, 2);
  try { await navigator.clipboard.writeText(text); $("#copy-diagnostics").textContent = "已复制脱敏摘要"; $("#copy-diagnostics-logs").textContent = "已复制脱敏 JSON"; setTimeout(() => { $("#copy-diagnostics").textContent = "复制脱敏摘要"; $("#copy-diagnostics-logs").textContent = "复制脱敏 JSON"; }, 1600); } catch { $("#page-notice").lastElementChild.textContent = "浏览器未授予剪贴板权限，摘要仍只存在当前页面。"; }
}

applyTheme(readTheme());
$("#theme-toggle").addEventListener("click", () => applyTheme(state.theme === "light" ? "dark" : "light", true));
document.querySelectorAll(".nav-item").forEach((item) => item.addEventListener("click", () => activate(item.dataset.section)));
document.querySelectorAll("[data-jump]").forEach((item) => item.addEventListener("click", () => activate(item.dataset.jump)));
$("#refresh-button").addEventListener("click", () => fetchSnapshot(true)); $("#copy-diagnostics").addEventListener("click", copyDiagnostics); $("#copy-diagnostics-logs").addEventListener("click", copyDiagnostics);
fetchSnapshot(); setInterval(() => fetchSnapshot(false), 8000);
