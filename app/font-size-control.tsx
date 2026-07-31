"use client";

export type FontSizePreference = "medium" | "large" | "xlarge";

const fontSizeOptions: Array<{
  value: FontSizePreference;
  label: string;
  labelZh: string;
  labelEn: string;
}> = [
  {
    value: "medium",
    label: "A",
    labelZh: "标准字体",
    labelEn: "Default text",
  },
  {
    value: "large",
    label: "A+",
    labelZh: "较大字体",
    labelEn: "Larger text",
  },
  {
    value: "xlarge",
    label: "A++",
    labelZh: "超大字体",
    labelEn: "Largest text",
  },
];

export function FontSizeControl({
  value,
  locale,
  onChange,
}: {
  value: FontSizePreference;
  locale: "zh" | "en";
  onChange: (value: FontSizePreference) => void;
}) {
  const groupLabel = locale === "zh" ? "字体大小" : "Text size";

  return (
    <div className="font-size-control" role="group" aria-label={groupLabel}>
      {fontSizeOptions.map((option) => {
        const label = locale === "zh" ? option.labelZh : option.labelEn;
        return (
          <button
            key={option.value}
            type="button"
            className={value === option.value ? "selected" : ""}
            aria-label={label}
            aria-pressed={value === option.value}
            title={label}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
