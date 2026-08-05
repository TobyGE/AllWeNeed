type VisitorCountry = {
  nameZh: string;
  nameEn: string;
  latitude: number | null;
  longitude: number | null;
  activeUsers: number;
};

export type TrafficSummary = {
  generatedAt: string;
  period: {
    labelZh: string;
    labelEn: string;
  };
  activeUsers: number;
  pageViews: number;
  countryCount: number;
  countries: VisitorCountry[];
};

function projectPoint(latitude: number, longitude: number) {
  return {
    x: ((longitude + 180) / 360) * 200,
    y: ((90 - latitude) / 180) * 86,
  };
}

export function VisitorMap({
  locale,
  summary,
}: {
  locale: "zh" | "en";
  summary: TrafficSummary;
}) {
  const isZh = locale === "zh";
  const maxVisitors = Math.max(
    1,
    ...summary.countries.map((country) => country.activeUsers),
  );

  return (
    <section
      className="visitor-map-card"
      aria-label={isZh ? "访问地图" : "Visitor map"}
    >
      <div className="visitor-map-topline">
        <span>{isZh ? "访问地图" : "VISITOR MAP"}</span>
        <span>{summary.period[isZh ? "labelZh" : "labelEn"]}</span>
      </div>

      <div className="visitor-map-metrics">
        <strong>{summary.pageViews.toLocaleString()}</strong>
        <span>
          {isZh
            ? `次浏览 · ${summary.activeUsers} 位访客`
            : `views · ${summary.activeUsers} visitors`}
        </span>
      </div>

      <svg
        className="visitor-map"
        viewBox="0 0 200 86"
        role="img"
        aria-label={
          isZh
            ? `${summary.countryCount} 个国家的聚合访问分布`
            : `Aggregated visits across ${summary.countryCount} countries`
        }
      >
        <g className="visitor-map-land" aria-hidden="true">
          <path d="M10 20 25 10l20 4 10 10-8 9 7 11-12 15-10-4-6-17-13-4Z" />
          <path d="m49 54 11 7 5 14-8 10-7-9-4-15Z" />
          <path d="m91 18 15-8 12 5 8-4 22 5 18 13-4 11 11 8-9 9-21-7-12 7-12-10-11 4-6-11-13-3-5-9Z" />
          <path d="m118 47 14 4 8 14-7 16-12-6-8-16Z" />
          <path d="m167 65 14-2 10 8-7 9-16-4Z" />
        </g>
        <g className="visitor-map-grid" aria-hidden="true">
          <path d="M0 22h200M0 43h200M0 64h200" />
          <path d="M50 0v86M100 0v86M150 0v86" />
        </g>
        {summary.countries.map((country) => {
          if (country.latitude === null || country.longitude === null) {
            return null;
          }
          const point = projectPoint(country.latitude, country.longitude);
          const radius = 2.6 + (country.activeUsers / maxVisitors) * 2.2;
          return (
            <g key={country.nameEn} className="visitor-map-point">
              <circle
                className="visitor-map-pulse"
                cx={point.x}
                cy={point.y}
                r={radius + 3}
              />
              <circle cx={point.x} cy={point.y} r={radius} />
              <title>
                {isZh ? country.nameZh : country.nameEn} ·{" "}
                {country.activeUsers}{" "}
                {isZh ? "位访客" : "visitors"}
              </title>
            </g>
          );
        })}
      </svg>

      <div className="visitor-country-list">
        {summary.countries.map((country) => (
          <span key={country.nameEn}>
            <i aria-hidden="true" />
            {isZh ? country.nameZh : country.nameEn}
            <b>{country.activeUsers}</b>
          </span>
        ))}
      </div>

      <p className="visitor-map-privacy">
        {isZh ? "按国家汇总" : "Country-level totals"}
      </p>
    </section>
  );
}
