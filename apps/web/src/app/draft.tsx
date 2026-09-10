import type { Lane } from "@subtitle-translator/pricing";
import { DEFAULT_TRANSLATION_OPTIONS, type TranslationOptions } from "@subtitle-translator/shared";
import { MAX_FILES_PER_UPLOAD } from "@subtitle-translator/subtitles";
import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { intake, type LocalFile, type RawFile } from "../features/upload/local-files.js";

/**
 * The upload the user is putting together: the files, the target language, the
 * lane and the options. It lives above the router because a top-up sends the
 * user to a checkout page and back, and losing a season's worth of dropped
 * files on the way would be unforgivable (spec section 2.1, step 4).
 */

export interface UploadDraft {
  files: LocalFile[];
  /** Entries in a zip or folder that were not subtitle files. */
  ignored: string[];
  targetLanguage: string | null;
  lane: Lane;
  options: TranslationOptions;
  addFiles: (raw: RawFile[]) => void;
  removeFile: (id: string) => void;
  clear: () => void;
  setTargetLanguage: (code: string) => void;
  setLane: (lane: Lane) => void;
  setOptions: (options: TranslationOptions) => void;
}

const DraftContext = createContext<UploadDraft | null>(null);

export function DraftProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [files, setFiles] = useState<LocalFile[]>([]);
  const [ignored, setIgnored] = useState<string[]>([]);
  const ignoredNames = useRef<string[]>([]);
  const [targetLanguage, setTargetLanguage] = useState<string | null>(null);
  const [lane, setLane] = useState<Lane>("fast");
  const [options, setOptions] = useState<TranslationOptions>(DEFAULT_TRANSLATION_OPTIONS);

  const addFiles = useCallback((raw: RawFile[]) => {
    setFiles((current) => {
      // Names already seen, ignored entries included: a `.idx` dropped a moment
      // before its `.sub` still has to mark that `.sub` as image-based.
      const result = intake(raw, [
        ...current.map((file) => file.fileName),
        ...ignoredNames.current,
      ]);
      ignoredNames.current = [...ignoredNames.current, ...result.ignored];
      setIgnored((seen) => [...seen, ...result.ignored]);
      // The cap is a product limit, not a suggestion (spec section 3.2).
      return [...current, ...result.files].slice(0, MAX_FILES_PER_UPLOAD);
    });
  }, []);

  const removeFile = useCallback((id: string) => {
    setFiles((current) => current.filter((file) => file.id !== id));
  }, []);

  const clear = useCallback(() => {
    setFiles([]);
    setIgnored([]);
    ignoredNames.current = [];
  }, []);

  const value = useMemo<UploadDraft>(
    () => ({
      files,
      ignored,
      targetLanguage,
      lane,
      options,
      addFiles,
      removeFile,
      clear,
      setTargetLanguage,
      setLane,
      setOptions,
    }),
    [files, ignored, targetLanguage, lane, options, addFiles, removeFile, clear],
  );

  return <DraftContext.Provider value={value}>{children}</DraftContext.Provider>;
}

export function useDraft(): UploadDraft {
  const draft = useContext(DraftContext);
  if (draft === null) throw new Error("useDraft was called outside a DraftProvider.");
  return draft;
}
