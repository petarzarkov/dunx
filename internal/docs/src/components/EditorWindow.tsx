import { useState } from 'react';
import { Highlighted } from './Highlighted';

export interface EditorFile {
  readonly name: string;
  readonly code: string;
  /** Key into the generate-time highlighted map. */
  readonly id: string;
}

/**
 * A tabbed editor frame for the landing page. The tab strip is a real
 * `tablist` - the files are alternative views of one panel, which is what the
 * pattern is for, and it keeps the sample reachable by keyboard.
 *
 * Not tokenised. There is no syntax highlighter in the bundle, and shipping one
 * to colour three samples would cost more than the samples are worth.
 */
export const EditorWindow = ({
  files,
  label,
}: {
  files: readonly EditorFile[];
  label: string;
}): React.JSX.Element => {
  const [active, setActive] = useState(0);
  const shown = files[active] ?? files[0];

  return (
    <div className="win">
      <div className="win-bar">
        <div className="win-dots" aria-hidden="true">
          <span className="win-dot" />
          <span className="win-dot" />
          <span className="win-dot" />
        </div>
        <div className="win-tabs" role="tablist" aria-label={label}>
          {files.map((file, index) => (
            <button
              key={file.name}
              type="button"
              role="tab"
              id={`tab-${label}-${file.name}`}
              aria-selected={index === active}
              aria-controls={`panel-${label}`}
              data-active={index === active}
              className="win-tab"
              onClick={() => setActive(index)}
            >
              {file.name}
            </button>
          ))}
        </div>
      </div>
      <div
        id={`panel-${label}`}
        role="tabpanel"
        aria-labelledby={`tab-${label}-${shown?.name ?? ''}`}
      >
        <Highlighted id={shown?.id ?? ''} fallback={shown?.code ?? ''} />
      </div>
    </div>
  );
};
