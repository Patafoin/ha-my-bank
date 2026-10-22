# My Bank para Home Assistant

🇬🇧 [Leer en inglés](https://github.com/Patafoin/ha-my-bank/blob/main/README.md) · 🇫🇷 [Leer en francés](https://github.com/Patafoin/ha-my-bank/blob/main/README.fr.md) · 🇩🇪 [Leer en alemán](https://github.com/Patafoin/ha-my-bank/blob/main/README.de.md)

[![Insignia de HACS](https://img.shields.io/badge/HACS-Custom-41BDF5.svg)](https://hacs.xyz/)
[![Validación](https://github.com/Patafoin/ha-my-bank/actions/workflows/validate.yml/badge.svg)](https://github.com/Patafoin/ha-my-bank/actions/workflows/validate.yml)
[![Pruebas](https://github.com/Patafoin/ha-my-bank/actions/workflows/tests.yml/badge.svg)](https://github.com/Patafoin/ha-my-bank/actions/workflows/tests.yml)

Gestión financiera personal en Home Assistant, como en los programas de finanzas personales para ordenador: cuentas con tres saldos, movimientos liquidados y conciliados, desgloses, transferencias, categorías jerárquicas, movimientos programados, presupuestos y gastos compartidos entre amigos: desde una tarjeta del panel, en el móvil, en cualquier lugar.

![Panel](https://raw.githubusercontent.com/Patafoin/ha-my-bank/main/docs/images/card-dashboard.png)

💬 Preguntas, comentarios e ideas: [debate en el foro de Home Assistant Community](https://community.home-assistant.io/t/my-bank-personal-bookkeeping-in-home-assistant-accounts-budgets-charts-scheduled-shared-expenses-100-local/1029114).

> La integración y las tarjetas están disponibles en **inglés, francés, alemán y español**; los mensajes del servidor dependen de las traducciones disponibles en el repositorio de My Bank API. La interfaz sigue el idioma de Home Assistant.

## Funcionamiento

My Bank consta de dos partes:

| Parte | Qué es | Cómo se instala |
|---|---|---|
| **My Bank API** | El servidor: almacena tus datos en una base de datos SQLite local, calcula saldos y presupuestos, genera movimientos programados y crea una copia de seguridad cada noche | **Aplicación** de Home Assistant (antes, *complemento*; Home Assistant OS / Supervised) o un contenedor **Docker** |
| **My Bank** (este repositorio) | La integración y sus tarjetas Lovelace: sensores, servicios e interfaz de usuario | **HACS** |

La integración es un cliente ligero: todas las reglas (saldos, bloqueo de movimientos conciliados, cálculos de presupuestos…) están en el servidor. Tus datos nunca salen de tu red.

## Requisitos

- Home Assistant **2026.2 o posterior** y [HACS](https://hacs.xyz/) para instalar la integración. Probado en 2026.2.3 y 2026.10.0.
- Para el servidor, puedes usar:
  - **Home Assistant OS** o una instalación **Supervised**, en un sistema de 64 bits (amd64 o aarch64, por ejemplo, Raspberry Pi 4/5 con la imagen de 64 bits), para usar la aplicación; probado en Home Assistant OS 18.3;
  - o **Docker** en cualquier equipo de 64 bits de tu red (amd64 o arm64), para instalaciones de Home Assistant Container / Core.

## Instalación

### 1. El servidor

**Home Assistant OS / Supervised — aplicación (recomendada)**

[![Añade el repositorio de aplicaciones a Home Assistant.](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FPatafoin%2Fha-addons)

También puedes hacerlo manualmente: Ajustes → **Aplicaciones** → **Instalar aplicación** → ⋮ → **Repositorios**; añade `https://github.com/Patafoin/ha-addons`. Después, instala **My Bank API** e inícialo. Eso es todo: la aplicación crea un token de acceso para Home Assistant y se anuncia automáticamente.

> En las versiones de Home Assistant anteriores al cambio de nombre, las aplicaciones se llaman **complementos** (Ajustes → Complementos → Tienda de complementos).

**Home Assistant Container / Core — Docker**

Primero, genera el token de acceso, una cadena aleatoria larga que Home Assistant usará para comunicarse con el servidor:

```bash
openssl rand -hex 32
# or: python3 -c "import secrets; print(secrets.token_urlsafe(32))"
```

Ponlo en `MYBANK_API_TOKEN` abajo y guárdalo: lo introducirás en Home Assistant en el paso 3.

```yaml
# compose.yaml
services:
  my-bank-api:
    image: ghcr.io/patafoin/my-bank-api:latest
    container_name: my-bank-api
    restart: unless-stopped
    ports:
      - "9931:8000"
    volumes:
      - ./data:/data
      - ./backups:/backups
    environment:
      TZ: Europe/Paris
      MYBANK_API_TOKEN: "paste-the-generated-token-here"
```

```bash
docker compose up -d
curl http://localhost:9931/api/v1/health   # the server answers
```

El token se almacena como hash en la base de datos. Cambia la variable y reinicia para sustituirlo; elimínala para revocarlo. Si prefieres no guardar el token en `compose.yaml`, omite `MYBANK_API_TOKEN` y crea uno dentro del contenedor: `docker exec my-bank-api my-bank token create ha` (solo se muestra una vez).

Consulta el [README de My Bank API](https://github.com/Patafoin/my-bank-api) para ver todos los ajustes.

### 2. La integración

[![Abre este repositorio en HACS.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=Patafoin&repository=ha-my-bank&category=integration)

En HACS: ⋮ → **Repositorios personalizados** → `https://github.com/Patafoin/ha-my-bank`, tipo **Integración**. Descarga **My Bank** y reinicia Home Assistant.

### 3. Conéctalos

- **Con la aplicación**: en Ajustes → Dispositivos y servicios aparecerá **My Bank** como integración detectada. Pulsa **Configurar** → **Enviar**.
- **Con Docker**: Ajustes → Dispositivos y servicios → **Añadir integración** → **My Bank**; después, introduce la URL del servidor (por ejemplo, `http://192.168.1.10:9931`) y el token generado en el paso 1.

![Configuración](https://raw.githubusercontent.com/Patafoin/ha-my-bank/main/docs/images/config-flow.png)

### 4. Añade la tarjeta

La tarjeta se registra automáticamente (no hay que añadir ningún recurso). Edita un panel → **Añadir tarjeta** → **My Bank**.

Si las tarjetas no aparecen en el selector después de instalar o actualizar, fuerza la recarga de la página (Ctrl+F5) o borra la caché de la aplicación Companion. Las tarjetas personalizadas están al final del selector; también puedes buscar «bank».

## Las tarjetas

### `custom:my-bank-card` — todo, con una pestaña por tema

| Pestaña (clave `sections`) | Contenido |
|---|---|
| `dashboard` | Saldos de todas las cuentas y presupuesto del mes actual |
| `transactions` | Movimientos de una cuenta con saldo acumulado; filtros (que se pueden guardar como predeterminados); añadir, editar, desglosar y transferir; liquidar (☐/☑) y conciliar (🔓/🔒) con un clic; un asistente de conciliación destaca el movimiento que explica una diferencia de saldo |
| `accounts` | Cuentas (corriente, ahorro, tarjeta, efectivo…), saldo inicial y cierre |
| `categories` / `tags` | Árbol de categorías (ingresos / gastos / ahorro) y clases, un segundo eje de análisis; consulta [Categorías y clases](#categorías-y-clases) |
| `payees` | Beneficiarios con categoría predeterminada |
| `budgets` | Presupuesto mensual por cuenta: previsto frente a real, diferencia y copia de un presupuesto anterior |
| `recurrences` | Movimientos programados (periódicos o a plazos), próximos vencimientos y generación automática |
| `shares` | Gastos compartidos de un grupo (vacaciones…): quién paga la próxima vez y quién debe a quién al final |
| `help` | Ayuda en la aplicación: primeros pasos, liquidación y conciliación (con un ejemplo práctico), conceptos, categorías y clases, programaciones, presupuestos y gastos compartidos |

```yaml
type: custom:my-bank-card
sections:        # optional: omit to show every tab
  - dashboard
  - transactions
```

Asigna a cada instancia de la tarjeta sus propios `sections` para crear, por ejemplo, una vista solo para operaciones o una vista de configuración.

| Movimientos | Presupuestos |
|---|---|
| ![Movimientos](https://raw.githubusercontent.com/Patafoin/ha-my-bank/main/docs/images/card-transactions.png) | ![Presupuestos](https://raw.githubusercontent.com/Patafoin/ha-my-bank/main/docs/images/card-budgets.png) |

| Movimientos programados | Gastos compartidos |
|---|---|
| ![Movimientos programados](https://raw.githubusercontent.com/Patafoin/ha-my-bank/main/docs/images/card-schedules.png) | ![Gastos compartidos](https://raw.githubusercontent.com/Patafoin/ha-my-bank/main/docs/images/card-shares.png) |

### Tarjetas pequeñas para un panel móvil

<img src="https://raw.githubusercontent.com/Patafoin/ha-my-bank/main/docs/images/mobile-cards.png" alt="Panel del móvil" width="320" align="right">

| Tarjeta | Opciones |
|---|---|
| `custom:my-bank-balance-card` | `account_id` — los tres saldos de una cuenta |
| `custom:my-bank-entry-card` | `account_id`, `fields` — entrada rápida, con campos rellenados a partir del beneficiario; el botón «Todos los campos» muestra los campos ocultos |
| `custom:my-bank-budget-card` | `budget_id`, `levels`, `period` (`month`, `cumul`, `all`) |
| `custom:my-bank-balance-history-card` | `account_ids`, `period` — historial de saldos (gráfico de líneas) de una o varias cuentas; una tarjeta = un gráfico, combina varias tarjetas para separar cuentas de escalas distintas |
| `custom:my-bank-upcoming-charge-card` | `account_ids`, `horizon` — importe de los próximos movimientos, por semana o por mes según el horizonte |
| `custom:my-bank-category-spending-card` | `account_ids`, `period` — gastos por categoría (barras); el importe más alto equivale al 100 % |
| `custom:my-bank-share-card` | — gastos compartidos |

Todas las tarjetas tienen un editor visual.

<br clear="right">

**Tarjetas de gráficos** — historial de saldos, próximos movimientos y gastos por categoría:

![Tarjetas de gráficos](https://raw.githubusercontent.com/Patafoin/ha-my-bank/main/docs/images/chart-cards.png)

## Categorías y clases

My Bank ofrece dos formas de clasificar un movimiento: la **categoría** y la **clase**. No cumplen la misma función.

**La categoría: para qué se usó el dinero; úsala primero.** Responde a «¿en qué se gastó (o para qué se recibió) este dinero?»: Alimentación, Vivienda, Combustible… Todo se organiza en torno a ella:
- los **presupuestos** (previsto frente a real por categoría),
- la tarjeta de **gastos por categoría**,
- el árbol de ingresos / gastos / ahorro y sus subcategorías,
- la **categoría predeterminada** de los beneficiarios, que rellena el formulario de entrada.

Un movimiento sin categoría no aparece en ninguno de estos apartados.

**La clase: un eje adicional y opcional para el análisis.** Responde a otra pregunta: «¿para quién o para qué?». Sirve para analizar: agrupar movimientos de distintas categorías o dividir una categoría. Las clases no tienen presupuesto; se usan principalmente para filtrar la lista de movimientos, que muestra el total.

**Ejemplo: dos coches**

| Movimiento | Categoría | Clase |
|---|---|---|
| Repostaje, 60 € | Combustible | Vehículo A |
| Repostaje, 45 € | Combustible | Vehículo B |
| Revisión, 180 € | Mantenimiento del vehículo | Vehículo A |

- La categoría **Combustible** incluye los 105 € de combustible en el presupuesto y en la tarjeta de gastos, sea cual sea el coche.
- La clase **Vehículo A** indica cuánto cuesta ese coche (240 €, incluido el combustible y el mantenimiento): filtra la lista de movimientos por esta clase. Con Categoría = Combustible y Clase = Vehículo A, solo verás el combustible de ese coche.

Evita asignar solo una clase sin categoría: el análisis por coche seguiría funcionando, pero esos gastos desaparecerían del presupuesto y de la tarjeta de gastos por categoría. Evita también crear las categorías «Combustible vehículo A» y «Combustible vehículo B»: multiplicarían las líneas del presupuesto para representar algo que la clase ya permite analizar.

**En resumen**: asigna siempre una categoría. Añade una clase cuando quieras hacer seguimiento de un objeto, un proyecto o una persona en varias categorías. En un movimiento desglosado, cada línea tiene su propia categoría y su propia clase.

## Entidades

- **Un sensor por cuenta**: estado = saldo total (incluidos los movimientos con fecha futura); atributos `solde_pointe` (liquidado), `solde_rapproche` (conciliado), `account_id`, `kind`, `iban`, `closed`. Se actualiza cada 5 minutos y después de cada cambio.
- **Movimientos programados que terminan** (`sensor.scheduled_transactions_ending` en una instalación en inglés; el ID de la entidad sigue el idioma de Home Assistant cuando se añade la integración): número de movimientos programados cuya última ocurrencia cae dentro de los próximos 30 días, con la lista en los atributos; útil para una automatización de notificaciones.

## Servicios

Se puede crear, modificar o eliminar cada objeto desde automatizaciones y scripts: `my_bank.create_transaction`, `create_transfer`, `set_transaction_state`, `create_schedule`, `set_budget_lines`, `add_shared_expense`… (más de 50 servicios; consulta **Herramientas de desarrollador → Acciones**). Los servicios de lectura (`list_accounts`, `search_transactions`, `get_budget_report`…) devuelven datos mediante `response_variable`.

```yaml
action: my_bank.create_transaction
data:
  account_id: 1
  date: "2026-10-09"
  amount: "-12.50"
  payee_name: Bakery
  category_id: 5
```

## Idiomas

Las tarjetas, los diálogos de configuración y los servicios siguen el idioma de Home Assistant: inglés, francés, alemán o español (inglés para cualquier otro idioma). Los mensajes del servidor dependen de las traducciones disponibles en el repositorio de My Bank API, que es independiente de este repositorio; aquí no se añade la traducción al español de los mensajes del servidor. En una instalación nueva, los métodos de pago predeterminados que crea el servidor se renombran según los idiomas que admita My Bank API.

## Actualización

Actualiza la integración con HACS y el servidor desde Ajustes → Aplicaciones (o con `docker compose pull`). Si el servidor es demasiado antiguo para la integración, Home Assistant muestra un aviso de reparación.

## Importar desde MS Comptes Bancaires

El servidor importa las exportaciones QIF y CSV de beneficiarios de MS Comptes Bancaires; consulta el [README de My Bank API](https://github.com/Patafoin/my-bank-api).

## Seguridad

Mantén My Bank API en tu red local. No lo expongas nunca a Internet: el acceso remoto se realiza a través de Home Assistant, que ya se encarga de la autenticación.

## Traducciones

Se agradece cualquier contribución para añadir o corregir un idioma:

- Textos de Home Assistant (configuración, servicios y reparaciones): `custom_components/my_bank/translations/<lang>.json`, con `strings.json` como fuente en inglés.
- Tarjetas: el diccionario `I18N` al final de `custom_components/my_bank/www/my-bank-card.js`, cuyas claves son los textos en francés de la tarjeta.
- Mensajes del servidor: `src/my_bank_api/i18n_messages.py` en [my-bank-api](https://github.com/Patafoin/my-bank-api).

Las pruebas verifican las traducciones de Home Assistant para todas las claves y marcadores de posición de origen, y que los diccionarios de las tarjetas estén completos en inglés, alemán y español.

## Licencia

MIT
