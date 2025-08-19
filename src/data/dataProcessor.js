/**
 * Processes the data based on the provided dimensions and measures and
 * supports multiple time formats with proper ordering.
 *
 * Allowed formats:
 *  - YYYY               e.g., "2023"
 *  - MMM YYYY           e.g., "JAN 2024"
 *  - MM/YYYY            e.g., "09/2022"
 *  - Qq YYYY            e.g., "Q2 2025" (q or Q)
 *  - Q/YYYY             e.g., "2/2023"   (quarter/year)
 *
 * Returns:
 *  {
 *    timeline: [ "2022", "2023", "JAN 2024", "Q2 2025", ... ],  // in ascending chronological order
 *    seriesByTime: { [label: string]: { [category: string]: number } }
 *  }
 */
export function processSeriesData(data, dimensions, measures) {
    const timeDimension = dimensions[0];
    const dimension = dimensions[1];
    const measure = measures[0];

    const seriesByTime = {};

    const parsed = []; // { label, ordinal }

    const MONTHS = {
        JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
        JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12
    };

    const reYear = /^(\d{4})$/;
    const reMmmYear = /^([A-Za-z]{3})\s+(\d{4})$/;
    const reMmYear = /^(\d{2})\/(\d{4})$/;
    const reQqYear = /^([Qq]([1-4]))\s+(\d{4})$/;  // "Q2 2025"
    const reQslashYear = /^([1-4])\/(\d{4})$/;         // "2/2025"

    function parseTimeLabel(label) {
        const s = String(label).trim();

        // YYYY
        let m = s.match(reYear);
        if (m) {
            const y = +m[1];
            return { label: String(y), ordinal: y * 12 + 0 };
        }

        // MMM YYYY
        m = s.match(reMmmYear);
        if (m) {
            const mm = MONTHS[m[1].toUpperCase()];
            const y = +m[2];
            if (mm) {
                return { label: `${m[1].toUpperCase()} ${y}`, ordinal: y * 12 + mm };
            }
        }

        // MM/YYYY
        m = s.match(reMmYear);
        if (m) {
            const mm = +m[1];
            const y = +m[2];
            if (mm >= 1 && mm <= 12) {
                return { label: `${String(mm).padStart(2, '0')}/${y}`, ordinal: y * 12 + mm };
            }
        }

        // Qq YYYY
        m = s.match(reQqYear);
        if (m) {
            const q = +m[2]; // 1..4
            const y = +m[3];
            const monthAnchor = q * 3; // use quarter end-month (Mar=3, Jun=6, Sep=9, Dec=12)
            return { label: `Q${q} ${y}`, ordinal: y * 12 + monthAnchor };
        }

        // Q/YYYY  (e.g. 2/2025)
        m = s.match(reQslashYear);
        if (m) {
            const q = +m[1];
            const y = +m[2];
            const monthAnchor = q * 3;
            return { label: `Q${q} ${y}`, ordinal: y * 12 + monthAnchor };
        }

        // Fallback: stick it at the end, but keep stable order by hashing the string
        const hash = Array.from(s).reduce((h, ch) => ((h << 5) - h) + ch.charCodeAt(0), 0) & 0xffff;
        return { label: s, ordinal: 10_000_000 + hash };
    }

    // Build seriesByTime and collect parsed labels with ordinals
    data.forEach(row => {
        const rawTime = row[timeDimension.key].label;
        const { label: normLabel, ordinal } = parseTimeLabel(rawTime);

        const category = row[dimension.key].label;
        const value = row[measure.key].raw;

        if (!seriesByTime[normLabel]) {
            seriesByTime[normLabel] = {};
            parsed.push({ label: normLabel, ordinal });
        }
        seriesByTime[normLabel][category] = value;
    });

    // Sort timeline by ordinal asc; keep stable sort for identical ordinals
    parsed.sort((a, b) => a.ordinal - b.ordinal);

    const timeline = parsed.map(p => p.label);

    return { timeline, seriesByTime };
}
