interface TracerChromeStorage {
  get<T extends Record<string, unknown>>(defaults: T): Promise<T>;
  set(values: Record<string, unknown>): Promise<void>;
}

interface TracerChromeTabs {
  query(
    queryInfo: { active?: boolean; currentWindow?: boolean },
  ): Promise<Array<{ id?: number }>>;
  sendMessage<T = unknown>(tabId: number, message: unknown): Promise<T>;
}

interface TracerChromeRuntime {
  onInstalled: {
    addListener(listener: () => void): void;
  };
  onMessage: {
    addListener(
      listener: (
        message: unknown,
        sender: TracerChromeRuntimeMessageSender,
        sendResponse: (response: unknown) => void,
      ) => boolean | void,
    ): void;
  };
}

interface TracerChromeRuntimeMessageSender {
  id?: string;
  tab?: { id?: number };
}

interface TracerChromeApi {
  storage: {
    local: TracerChromeStorage;
  };
  tabs: TracerChromeTabs;
  runtime: TracerChromeRuntime;
}

declare const chrome: TracerChromeApi;
