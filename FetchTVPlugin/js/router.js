const t = new URL(location.href),
    e = t.searchParams.get("path");
if (((document.title = "Loading..."), e))
    try {
        const t = document.getElementById("go");
        (t.href = location.origin + e), t.click();
    } catch (t) {
        const c = document.createElement("a");
        (c.href = location.origin + e), (c.target = "_self"), document.body.append(c), c.click();
    }
