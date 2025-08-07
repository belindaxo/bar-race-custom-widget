
/**
 * Returns a CSSStyleSheet instance for the Bubble Chart widget.
 * This is applied to the widget's shadow DOM.
 * @returns {CSSStyleSheet}
 */
export function createChartStylesheet() {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`
        @font-face {
            font-family: '72';
            src: url('../fonts/72-Regular.woff2') format('woff2');
        }
        #container {
            width: 100%;
            height: 100%;
            font-family: '72';
        }
    `);
    return sheet;
}