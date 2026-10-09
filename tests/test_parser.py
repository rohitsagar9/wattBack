from wattback.ingest.pvoutput import parse_list_html

CLEAN_ROW = (
    '<tr class="even"><td><a href="intraday.jsp?id=63115&sid=56151&dt=20260830">'
    "30 Aug</a></td>"
    "<td>2.4%</td><td>104.605kWh</td><td>1.6h</td><td>4.1h</td>"
    "<td>19.484kW</td><td>1:30PM</td><td>Sunny</td><td>30 to 38C</td></tr>"
)

JUNK_ROW = (
    "<tr><td><script>chart(); /* "
    "intraday.jsp?id=63115&sid=56151&dt=20260722 */</script></td>"
    "<td>a</td><td>{y:1.8, valueSuffix: 'kWh'}</td><td>b</td><td>c</td>"
    "<td>d</td><td>e</td><td>f</td><td>g</td></tr>"
)

NO_DATE_ROW = '<tr><td><td>1.000kWh</td><td>x</td></tr>'

SHORT_ROW = (
    '<tr><td><a href="intraday.jsp?id=1&sid=2&dt=20260101">x</a></td>'
    "<td>1.000kWh</td></tr>"
)


def test_parses_clean_row():
    rows = parse_list_html(CLEAN_ROW)
    assert rows == [
        {
            "date": "20260830",
            "generated": "104.605kWh",
            "peak": "19.484kW",
            "time": "1:30PM",
            "conditions": "Sunny",
            "temp": "30 to 38C",
        }
    ]


def test_rejects_highcharts_junk_despite_kwh_text():
    rows = parse_list_html(JUNK_ROW)
    assert rows == []


def test_rejects_rows_without_date_or_cells():
    assert parse_list_html(NO_DATE_ROW) == []
    assert parse_list_html(SHORT_ROW) == []


def test_mixed_page_keeps_only_clean():
    html = NO_DATE_ROW + JUNK_ROW + CLEAN_ROW + SHORT_ROW
    rows = parse_list_html(html)
    assert len(rows) == 1
    assert rows[0]["date"] == "20260830"
