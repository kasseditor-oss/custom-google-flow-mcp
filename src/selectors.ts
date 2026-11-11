/**
 * Centralized, self-healing DOM selectors for Google Flow.
 *
 * Google Labs ships UI changes often. Every element is described by an ordered
 * list of strategies, from most stable to most fragile:
 *   1. Material Symbols icon ligatures (language independent: "arrow_forward", "tune"...)
 *   2. aria-label in PT-BR and EN-US
 *   3. ARIA role + accessible name
 *   4. Visible text
 *   5. data-* attributes / structural CSS
 *
 * When Flow changes, update ONLY this file. `flow_health_check` reports which
 * strategy matched for each key so you can see what drifted.
 */
import type { Locator, Page } from "playwright-core";
import type { CameraMotion } from "./types.js";

export interface SelectorStrategy {
  label: string;
  locate: (page: Page) => Locator;
}

export interface SelectorDef {
  key: string;
  description: string;
  /** Critical selectors must be visible on a ready Flow project page. */
  critical: boolean;
  strategies: SelectorStrategy[];
}

export const ICON_TAGS = [
  "i",
  "mat-icon",
  "span.material-symbols-outlined",
  "span.material-symbols-rounded",
  "span.material-icons",
  "span.google-symbols",
  "i.google-symbols",
].join(", ");

const CLICKABLE = "button, [role='button'], [role='menuitem'], [role='tab'], [role='option'], a";

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Regex matching any of the words (optionally anchored as an exact label). */
export function anyText(words: readonly string[], exact = false): RegExp {
  const body = words.map(escapeRegex).join("|");
  return new RegExp(exact ? `^\\s*(?:${body})\\s*$` : `(?:${body})`, "i");
}

export function withIcon(page: Page, icon: RegExp, scope: string = CLICKABLE): Locator {
  return page.locator(scope).filter({ has: page.locator(ICON_TAGS, { hasText: icon }) });
}

function ariaContains(page: Page, tags: string, words: readonly string[]): Locator {
  const selector = tags
    .split(",")
    .map((tag) => tag.trim())
    .flatMap((tag) => words.map((word) => `${tag}[aria-label*="${word.replace(/"/g, '\\"')}" i]`))
    .join(", ");
  return page.locator(selector);
}

/** UI vocabulary (PT-BR first, then EN-US). */
export const TEXT = {
  generate: ["Gerar", "Criar", "Enviar", "Generate", "Create", "Send", "Submit"],
  settings: ["Configurações", "Configuracoes", "Ajustes", "Opções", "Settings", "Options", "Generation settings"],
  newProject: ["Novo projeto", "Criar projeto", "New project", "Create project", "Start new project"],
  addMedia: [
    "Adicionar mídia", "Adicionar imagem", "Adicionar ingrediente", "Adicionar referência", "Fazer upload", "Enviar imagem", "Carregar imagem",
    "Add media", "Add image", "Add ingredient", "Add reference", "Upload",
  ],
  uploadFromComputer: ["Fazer upload", "Do computador", "Carregar do dispositivo", "Upload", "From computer", "Upload image"],
  startFrame: ["Frame inicial", "Primeiro frame", "Quadro inicial", "Imagem inicial", "Start frame", "First frame", "Starting frame"],
  endFrame: ["Frame final", "Último frame", "Ultimo frame", "Quadro final", "Imagem final", "End frame", "Last frame", "Ending frame"],
  ingredient: ["Ingrediente", "Ingredientes", "Referência", "Referencia", "Ingredient", "Ingredients", "Reference"],
  camera: ["Controle de câmera", "Controles de câmera", "Movimento de câmera", "Movimentos de câmera", "Câmera", "Camera control", "Camera controls", "Camera motion", "Camera"],
  signIn: ["Fazer login", "Entrar", "Sign in", "Log in"],
  download: ["Baixar", "Fazer download", "Download"],
  more: ["Mais opções", "Mais ações", "More options", "More actions", "More"],
  save: ["Salvar", "Concluído", "Concluir", "Aplicar", "OK", "Save", "Done", "Apply"],
  close: ["Fechar", "Close"],
  aspectRatio: ["Proporção", "Formato", "Proporção da tela", "Aspect ratio", "Orientation"],
  outputs: ["Saídas", "Resultados", "Variações", "Outputs", "Variations", "Results"],
  model: ["Modelo", "Model"],
  textToVideo: ["Texto para vídeo", "Texto em vídeo", "Text to Video"],
  framesToVideo: ["Frames para vídeo", "Quadros para vídeo", "Frames to Video"],
  ingredientsToVideo: ["Ingredientes para vídeo", "Ingredients to Video"],
  createImage: ["Criar imagem", "Gerar imagem", "Texto para imagem", "Create Image", "Text to Image"],
} as const;

/** Visible-label vocabulary for each camera motion, plus the prompt directive used as fallback. */
export const CAMERA_MOTION_VOCAB: Record<CameraMotion, { labels: string[]; directive: string }> = {
  static: { labels: ["Estática", "Estático", "Fixa", "Câmera fixa", "Static", "Locked", "Fixed"], directive: "Static locked-off camera, no camera movement." },
  pan_left: { labels: ["Pan para a esquerda", "Panorâmica para a esquerda", "Panorâmica à esquerda", "Pan left"], directive: "Smooth camera pan to the left." },
  pan_right: { labels: ["Pan para a direita", "Panorâmica para a direita", "Panorâmica à direita", "Pan right"], directive: "Smooth camera pan to the right." },
  tilt_up: { labels: ["Inclinar para cima", "Tilt para cima", "Tilt up"], directive: "Camera tilts up smoothly." },
  tilt_down: { labels: ["Inclinar para baixo", "Tilt para baixo", "Tilt down"], directive: "Camera tilts down smoothly." },
  zoom_in: { labels: ["Aproximar", "Zoom in", "Mais zoom"], directive: "Slow zoom in." },
  zoom_out: { labels: ["Afastar", "Zoom out", "Menos zoom"], directive: "Slow zoom out." },
  dolly_in: { labels: ["Dolly in", "Dolly para frente", "Avançar"], directive: "Slow dolly in toward the subject." },
  dolly_out: { labels: ["Dolly out", "Dolly para trás", "Recuar"], directive: "Slow dolly out away from the subject." },
  orbit_left: { labels: ["Orbitar para a esquerda", "Órbita à esquerda", "Orbit left"], directive: "Camera orbits around the subject to the left." },
  orbit_right: { labels: ["Orbitar para a direita", "Órbita à direita", "Orbit right"], directive: "Camera orbits around the subject to the right." },
};

const def = (key: string, description: string, critical: boolean, strategies: SelectorStrategy[]): SelectorDef => ({
  key,
  description,
  critical,
  strategies,
});

export const SELECTORS = {
  promptInput: def("promptInput", "Prompt editor", true, [
    { label: "role=textbox aria create", locate: (p) => p.locator('[role="textbox"][aria-label*="create" i], [role="textbox"][aria-label*="criar" i], [role="textbox"][aria-label*="crie" i]') },
    { label: "textarea[placeholder]", locate: (p) => p.locator('textarea[placeholder*="prompt" i], textarea[placeholder*="descrev" i], textarea[placeholder*="describe" i], textarea[placeholder*="crie" i], textarea[placeholder*="create" i]') },
    { label: "contenteditable textbox", locate: (p) => p.locator('[contenteditable="true"][role="textbox"], [contenteditable="true"][data-placeholder]') },
    { label: "role=textbox", locate: (p) => p.getByRole("textbox") },
    { label: "any textarea", locate: (p) => p.locator("textarea") },
    { label: "any contenteditable", locate: (p) => p.locator('[contenteditable="true"]') },
  ]),
  generateButton: def("generateButton", "Submit / Generate button", true, [
    { label: "aria Start generation", locate: (p) => p.locator('button[aria-label="Start generation" i], button[aria-label*="Iniciar gera" i], button[aria-label*="Gerar" i][type="submit"]') },
    { label: "icon arrow_forward/send", locate: (p) => withIcon(p, /^(?:arrow_forward|send|arrow_upward|north)$/, "button") },
    { label: "aria-label generate", locate: (p) => ariaContains(p, "button", TEXT.generate) },
    { label: "role button exact text", locate: (p) => p.getByRole("button", { name: anyText(TEXT.generate, true) }) },
    { label: "submit button", locate: (p) => p.locator('button[type="submit"]') },
  ]),
  settingsButton: def("settingsButton", "Generation settings trigger (model / ratio / outputs chip)", false, [
    { label: "aria Settings trigger", locate: (p) => p.locator('button[aria-label="Settings trigger" i], button[aria-label*="configurações de gera" i]') },
    { label: "chip with crop icon", locate: (p) => withIcon(p, /^crop_(?:16_9|9_16|square|landscape|portrait)$/, "button") },
    { label: "icon tune/settings", locate: (p) => withIcon(p, /^(?:tune|settings_2|settings|page_info)$/, "button") },
    { label: "aria-label settings", locate: (p) => ariaContains(p, "button", TEXT.settings) },
    { label: "role button settings", locate: (p) => p.getByRole("button", { name: anyText(TEXT.settings) }) },
  ]),
  newProjectButton: def("newProjectButton", "New project button (Flow home)", false, [
    { label: "icon add_2/add", locate: (p) => withIcon(p, /^(?:add_2|add|add_circle)$/, "button, a") },
    { label: "aria-label new project", locate: (p) => ariaContains(p, "button, a", TEXT.newProject) },
    { label: "role button new project", locate: (p) => p.getByRole("button", { name: anyText(TEXT.newProject) }) },
    { label: "visible text new project", locate: (p) => p.getByText(anyText(TEXT.newProject)) },
  ]),
  projectLink: def("projectLink", "Existing project card/link", false, [
    { label: "href /project/", locate: (p) => p.locator('a[href*="/project/"]:not([href*="/shared/"])') },
    { label: "data-project-id", locate: (p) => p.locator("[data-project-id]") },
  ]),
  addMediaButton: def("addMediaButton", "Add media / ingredient button", false, [
    { label: "aria Add ingredients", locate: (p) => p.locator('button[aria-label*="Add ingredients" i], button[aria-label*="Adicionar ingrediente" i]') },
    { label: "icon add_photo/image", locate: (p) => withIcon(p, /^(?:add_photo_alternate|add_a_photo|image|photo_library|add_circle|add|attach_file|upload)$/, "button") },
    { label: "aria-label add media", locate: (p) => ariaContains(p, "button", TEXT.addMedia) },
    { label: "role button add media", locate: (p) => p.getByRole("button", { name: anyText(TEXT.addMedia) }) },
  ]),
  uploadMenuItem: def("uploadMenuItem", "Upload-from-computer menu item", false, [
    { label: "icon upload", locate: (p) => withIcon(p, /^(?:upload|file_upload|cloud_upload|computer)$/, "[role='menuitem'], [role='option'], button") },
    { label: "text upload", locate: (p) => p.getByRole("menuitem", { name: anyText(TEXT.uploadFromComputer) }) },
    { label: "visible text upload", locate: (p) => p.getByText(anyText(TEXT.uploadFromComputer)) },
  ]),
  fileInput: def("fileInput", "Hidden file input", false, [
    { label: "input[type=file][accept*=image]", locate: (p) => p.locator('input[type="file"][accept*="image"]') },
    { label: "input[type=file]", locate: (p) => p.locator('input[type="file"]') },
  ]),
  startFrameSlot: def("startFrameSlot", "Start frame slot (Frames to Video)", false, [
    { label: "aria-label start frame", locate: (p) => ariaContains(p, "button, [role='button'], div", TEXT.startFrame) },
    { label: "role button start frame", locate: (p) => p.getByRole("button", { name: anyText(TEXT.startFrame) }) },
    { label: "visible text start frame", locate: (p) => p.getByText(anyText(TEXT.startFrame)) },
  ]),
  endFrameSlot: def("endFrameSlot", "End frame slot (Frames to Video)", false, [
    { label: "aria-label end frame", locate: (p) => ariaContains(p, "button, [role='button'], div", TEXT.endFrame) },
    { label: "role button end frame", locate: (p) => p.getByRole("button", { name: anyText(TEXT.endFrame) }) },
    { label: "visible text end frame", locate: (p) => p.getByText(anyText(TEXT.endFrame)) },
  ]),
  cameraControlButton: def("cameraControlButton", "Camera control button", false, [
    { label: "icon videocam/camera", locate: (p) => withIcon(p, /^(?:videocam|camera|camera_video|motion_photos_on|360|control_camera)$/, "button") },
    { label: "aria-label camera", locate: (p) => ariaContains(p, "button", TEXT.camera) },
    { label: "role button camera", locate: (p) => p.getByRole("button", { name: anyText(TEXT.camera) }) },
  ]),
  modeSelector: def("modeSelector", "Generation mode selector (Text/Frames/Ingredients to Video)", false, [
    { label: "combobox with mode text", locate: (p) => p.locator("[role='combobox'], button[aria-haspopup]").filter({ hasText: anyText([...TEXT.textToVideo, ...TEXT.framesToVideo, ...TEXT.ingredientsToVideo, ...TEXT.createImage]) }) },
    { label: "visible mode text", locate: (p) => p.getByText(anyText([...TEXT.textToVideo, ...TEXT.framesToVideo, ...TEXT.ingredientsToVideo])) },
  ]),
  modelDropdown: def("modelDropdown", "Model dropdown (Veo / Nano Banana / Imagen)", false, [
    { label: "menu button with model name", locate: (p) => p.locator("button[aria-haspopup], [role='combobox']").filter({ hasText: /veo|omni|banana|imagen|gemini/i }) },
    { label: "aria-label model", locate: (p) => ariaContains(p, "button, [role='combobox']", TEXT.model) },
  ]),
  enterAppButton: def("enterAppButton", "'Create with Google Flow' CTA on the landing page", false, [
    { label: "role button create with flow", locate: (p) => p.getByRole("button", { name: anyText(["Crie com o Google Flow", "Criar com o Google Flow", "Create with Google Flow", "Create with Flow", "Try Google Flow", "Teste no Google Flow"]) }) },
    { label: "role link create with flow", locate: (p) => p.getByRole("link", { name: anyText(["Crie com o Google Flow", "Create with Google Flow", "Create with Flow"]) }) },
  ]),
  signInButton: def("signInButton", "Sign-in button (visible only when logged out)", false, [
    { label: "role button sign in", locate: (p) => p.getByRole("button", { name: anyText(TEXT.signIn, true) }) },
    { label: "role link sign in", locate: (p) => p.getByRole("link", { name: anyText(TEXT.signIn, true) }) },
    { label: "accounts.google.com link", locate: (p) => p.locator('a[href*="accounts.google.com/ServiceLogin"], a[href*="accounts.google.com/v3/signin"]') },
  ]),
  accountAvatar: def("accountAvatar", "Google account avatar (visible when logged in)", false, [
    { label: "aria-label Google Account", locate: (p) => ariaContains(p, "button, a", ["Google Account", "Conta do Google", "Conta Google"]) },
    { label: "avatar image", locate: (p) => p.locator('img[src*="googleusercontent.com/a/"], img[alt*="profile" i], img[alt*="perfil" i]') },
  ]),
  generatedVideo: def("generatedVideo", "Generated video elements", false, [
    { label: "flow-video-tile / video", locate: (p) => p.locator("flow-video-tile, video:not(flow-video-tile video)") },
  ]),
  generatedImage: def("generatedImage", "Generated image elements", false, [
    {
      label: "img /asb/ | blob | googleusercontent (excluding video thumbnails and avatars)",
      locate: (p) => p.locator([
        "flow-image-tile img",
        'img[src*="flow-content.google/image"]:not(flow-image-tile img)',
        'img[src*="/asb/"]:not([alt*="video" i]):not(flow-video-tile img):not(flow-image-tile img)',
        'img[src^="blob:"]:not([alt*="video" i]):not(flow-video-tile img)',
        'img[src*="storage.googleapis"]:not(flow-video-tile img)',
      ].join(", ")),
    },
  ]),
  downloadMenuItem: def("downloadMenuItem", "Download menu item in asset menu", false, [
    { label: "icon download", locate: (p) => withIcon(p, /^(?:download|file_download)$/, "[role='menuitem'], button") },
    { label: "role menuitem download", locate: (p) => p.getByRole("menuitem", { name: anyText(TEXT.download) }) },
  ]),
  autoApproveRadio: def("autoApproveRadio", "Agent credit auto-approve radio", false, [
    { label: "radio value AUTO_APPROVE", locate: (p) => p.locator('[role="radio"][value="AUTO_APPROVE"], input[type="radio"][value="AUTO_APPROVE"]') },
  ]),
  saveButton: def("saveButton", "Save/Done in settings panel", false, [
    { label: "role button save", locate: (p) => p.getByRole("button", { name: anyText(TEXT.save, true) }) },
    { label: "icon check/done", locate: (p) => withIcon(p, /^(?:check|done)$/, "button") },
  ]),
  closeButton: def("closeButton", "Close button of panels/dialogs", false, [
    { label: "icon close", locate: (p) => withIcon(p, /^close$/, "button") },
    { label: "aria-label close", locate: (p) => ariaContains(p, "button", TEXT.close) },
  ]),
} satisfies Record<string, SelectorDef>;

export type SelectorKey = keyof typeof SELECTORS;

/** Selectors probed by flow_health_check on a ready project page. */
export const HEALTH_CHECK_KEYS: SelectorKey[] = [
  "promptInput",
  "generateButton",
  "settingsButton",
  "addMediaButton",
  "fileInput",
  "modelDropdown",
  "modeSelector",
  "cameraControlButton",
  "accountAvatar",
];

/** Text patterns used to classify failures. Applied only to text that appeared after submit. */
export const PATTERNS = {
  login: /sign in to continue|choose an account|use your google account|fazer login para continuar|escolha uma conta|use sua conta do google/i,
  rateLimit: /rate limit|too many requests|quota|try again later|slow down|muitas solicita|limite de (?:uso|taxa|solicita|gera)|tente novamente mais tarde|aguarde alguns|você atingiu o limite|you(?:'ve| have) reached (?:your|the) limit/i,
  policy: /blocked by policy|violat|safety (?:filter|guidelines)|could not generate.*(?:safety|policy)|pol[ií]tica(?:s)? de (?:uso|conte[uú]do)|diretrizes de seguran[cç]a|conte[uú]do (?:bloqueado|sens[ií]vel)/i,
  credits: /not enough (?:ai )?credits|out of credits|insufficient credits|cr[eé]ditos insuficientes|sem cr[eé]ditos|seus cr[eé]ditos acabaram/i,
  failure: /generation failed|couldn't generate|could not generate|unable to generate|something went wrong|an error occurred|falha (?:na|ao) gera|n[aã]o foi poss[ií]vel gerar|algo deu errado|ocorreu um erro|erro ao gerar/i,
};
