// The app's name: Universal Docs on the web (and in ChatGPT), MCP Docs as the desktop app.

export const HOSTED_NAME = 'Universal Docs';
export const LOCAL_NAME = 'MCP Docs';

export const appName = (local: boolean): string => (local ? LOCAL_NAME : HOSTED_NAME);
