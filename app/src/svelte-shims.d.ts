/// <reference types="svelte" />
/// <reference types="vite/client" />

declare module "*.wav" {
  const url: string;
  export default url;
}

declare module "*.mp3" {
  const url: string;
  export default url;
}
