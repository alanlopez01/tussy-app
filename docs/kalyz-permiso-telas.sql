-- PARA CORRER EN KALYZ, no en tussy-app. Es lo único que falta para que la
-- Deuda Shato de tussy-app deje de pedir la tela a mano.
--
-- POR QUÉ: en tussy-app el lado "tussy" de la Deuda Shato (la tela que Tussy
-- le carga a Shato) se cargaba a mano y se cortó el 20/08/2026. La tela ya
-- está medida en producción, corte por corte, y KALYZ ya sabe valuarla: la
-- regla está en la 0271. Falta que tussy_app_lectura (0313) pueda leerla.
--
-- CÓMO: una vista en `core` con el consumo de tela de Shato ya valuado, y
-- SELECT sobre ella. Así tussy-app NO recibe el schema `produccion` entero:
-- ve los consumos de Shato y nada más. La vista corre con los permisos de su
-- dueño, por eso el lector no necesita nada de `produccion`.
--
-- La valuación es la misma cascada de la 0271 (precio de la línea, override de
-- la tela, precio del tipo) y sin precio debe cero: no se inventa un precio.
-- No hay límite de fecha acá: el límite lo pone tussy-app con su último cargo
-- a mano, igual que lo hace la 0271, para que ningún corte se cobre dos veces.

create or replace view core.v_tela_de_shato as
  select ct.id                                           as linea_id,
         c.fecha                                         as fecha,
         c.numero                                        as corte,
         tt.nombre || coalesce(' · ' || te.color, '')      as tela,
         ct.cantidad                                     as cantidad,
         tt.unidad                                       as unidad,
         coalesce(ct.precio_transferencia_centavos,
                  te.precio_transferencia_override_centavos,
                  tt.precio_transferencia_centavos)      as precio_centavos,
         coalesce(ct.importe_transferencia_centavos,
                  round(ct.cantidad * coalesce(te.precio_transferencia_override_centavos,
                                               tt.precio_transferencia_centavos))::bigint,
                  0::bigint)                             as importe_centavos,
         ct.creado_en                                    as registrado_en
    from produccion.cortes_telas ct
    join produccion.cortes c      on c.id = ct.corte_id
    join produccion.telas te      on te.id = ct.tela_id
    join produccion.tipos_tela tt on tt.id = te.tipo_tela_id
    join core.empresas e          on e.codigo = ct.empresa_codigo
    join core.empresas ep         on ep.codigo = 'produccion'
   where e.paga_transferencia_tela
     and e.sociedad_codigo  = 'shato'
     and ep.sociedad_codigo = 'tussy_sa'
     and not ct.anulada and not c.anulado
     and not coalesce(ct.es_prueba, false);

comment on view core.v_tela_de_shato is
  'El consumo de tela de Shato en cortes de Tussy S.A., ya valuado al precio de '
  'transferencia (misma cascada que la 0271). La lee tussy-app para su Deuda Shato.';

grant select on core.v_tela_de_shato to tussy_app_lectura;

-- DESPUÉS, EN TUSSY-APP: node scripts/sincronizar-telas.js
-- Si la vista queda con otro nombre, hay que cambiarlo en lib/telas.js.
